import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { groundQuestionValues, planOpenWorldSql } from "../lib/open-world-sql-planner.ts";
import type { DatasetColumn, SqlExecutionResult } from "../lib/sql-runtime.ts";

const schema: DatasetColumn[] = [
  { table: "client_accounts", name: "client_key", type: "INTEGER", primaryKey: true },
  { table: "client_accounts", name: "territory", type: "VARCHAR" },
  { table: "sales_ledger", name: "entry_key", type: "INTEGER" },
  { table: "sales_ledger", name: "client_key", type: "INTEGER", references: [{ table: "client_accounts", column: "client_key" }] },
  { table: "sales_ledger", name: "state", type: "VARCHAR" },
  { table: "sales_ledger", name: "net_amount", type: "DOUBLE" },
];

function execution(query: string, columns = ["territory", "revenue"], rows: unknown[][] = [["West", 42]]): SqlExecutionResult {
  return {
    columns, rows,
    receipt: {
      engine: "duckdb", input: { filename: "development.duckdb", sha256: "a".repeat(64), sizeBytes: 1024 },
      querySha256: createHash("sha256").update(query.trim().replace(/;\s*$/, "")).digest("hex"), readOnly: true, externalAccess: false,
      rowLimit: 200, returnedRows: rows.length, truncated: false, durationMs: 4,
    },
  };
}

test("grounds question values against arbitrary approved text columns without domain names", async () => {
  let groundingQuery = "";
  const matches = await groundQuestionValues("Total net amount for settled entries", schema, async (query) => {
    groundingQuery = query;
    return execution(query, ["field", "value"], [["sales_ledger.state", "settled"]]);
  });
  assert.deepEqual(matches, [{ field: "sales_ledger.state", value: "settled" }]);
  assert.match(groundingQuery, /sales_ledger/);
  assert.match(groundingQuery, /STRPOS/);
  assert.doesNotMatch(groundingQuery, /orders|customers|BIRD/i);
});

test("rejects substring value collisions while preserving quoted short values", async () => {
  const values = await groundQuestionValues("Find the pets heavier than 10", schema, async (query) => execution(query, ["field", "value"], [
    ["client_accounts.territory", "F"],
    ["client_accounts.territory", "Han"],
  ]));
  assert.deepEqual(values, []);
  const quoted = await groundQuestionValues("Show territory 'F'", schema, async (query) => execution(query, ["field", "value"], [["client_accounts.territory", "F"]]));
  assert.deepEqual(quoted, [{ field: "client_accounts.territory", value: "F" }]);
  const code = await groundQuestionValues("What are all regions?", schema, async (query) => execution(query, ["field", "value"], [["client_accounts.territory", "ARE"]]));
  assert.deepEqual(code, []);
  const exactCode = await groundQuestionValues("Show region USA", schema, async (query) => execution(query, ["field", "value"], [["client_accounts.territory", "USA"]]));
  assert.deepEqual(exactCode, [{ field: "client_accounts.territory", value: "USA" }]);
});

test("selects an independently executing consensus candidate over a disagreeing typed plan", async () => {
  const typed = `SELECT territory, COUNT(*) AS revenue FROM client_accounts GROUP BY territory`;
  const correct = `SELECT c.territory, SUM(s.net_amount) AS revenue FROM sales_ledger s JOIN client_accounts c ON c.client_key = s.client_key WHERE s.state = 'settled' GROUP BY c.territory ORDER BY c.territory`;
  const plan = await planOpenWorldSql({
    request: "Show total settled net amount by territory",
    columns: schema,
    modelId: "development-model",
    typedCandidate: { query: typed, explanation: "Count accounts." },
    dependencies: {
      completeJson: async (messages) => {
        assert.match(messages[1].content, /client_accounts/);
        assert.match(messages[1].content, /sales_ledger/);
        assert.match(messages[1].content, /DECLARED FOREIGN KEY/);
        assert.match(messages[1].content, /PRIMARY KEY/);
        return JSON.stringify({ decision: "query", explanation: "Use the ledger measure and client territory.", candidates: [
          { query: correct, explanation: "Sum settled ledger amounts by the related client territory." },
          { query: correct.replace(/ORDER BY c\.territory$/, "ORDER BY c.territory ASC"), explanation: "Equivalent explicit ordering." },
        ] });
      },
      executeSql: async (query) => {
        if (query.includes('AS "field"')) return execution(query, ["field", "value"], [["sales_ledger.state", "settled"]]);
        return query === typed ? execution(query, ["territory", "revenue"], [["West", 2]]) : execution(query);
      },
    },
  });
  assert.equal(plan.action, "query");
  assert.match(plan.selected?.query ?? "", /SUM\(s\.net_amount\)/);
  assert.deepEqual(plan.selected?.execution.rows, [["West", 42]]);
  assert.equal(plan.attempts.filter((attempt) => attempt.status === "success").length, 3);
  assert.ok(plan.focusedFields.includes("sales_ledger.net_amount"));
  assert.deepEqual(plan.groundedValues, [{ field: "sales_ledger.state", value: "settled" }]);
});

test("repairs execution failures once and keeps prohibited SQL out of the runtime", async () => {
  const attempted: string[] = [];
  let generations = 0;
  const repaired = `SELECT territory, COUNT(*) AS revenue FROM client_accounts GROUP BY territory ORDER BY territory`;
  const plan = await planOpenWorldSql({
    request: "Count clients by territory",
    columns: schema,
    modelId: "development-model",
    dependencies: {
      completeJson: async () => {
        generations += 1;
        return generations === 1
          ? JSON.stringify({ decision: "query", explanation: "Generate candidates.", candidates: [
            { query: "DROP TABLE client_accounts", explanation: "Unsafe." },
            { query: "SELECT missing FROM client_accounts", explanation: "Wrong column." },
          ] })
          : JSON.stringify({ decision: "query", explanation: "Repair the failed query.", candidates: [{ query: repaired, explanation: "Count approved rows by territory." }] });
      },
      executeSql: async (query) => {
        if (query.includes('AS "field"')) return execution(query, ["field", "value"], []);
        attempted.push(query);
        if (query.includes("missing")) throw new Error("Column missing does not exist");
        return execution(query, ["territory", "revenue"], [["West", 2]]);
      },
    },
  });
  assert.equal(generations, 2);
  assert.equal(plan.action, "query");
  assert.equal(plan.selected?.source, "repair");
  assert.deepEqual(attempted, ["SELECT missing FROM client_accounts", repaired]);
  assert.ok(plan.attempts.some((attempt) => attempt.status === "invalid"));
});

test("normalizes contradictory model envelopes and verifies a generic compiler candidate", async () => {
  const compiledSchema: DatasetColumn[] = [
    { table: "inventory_items", name: "item_number", type: "INTEGER", primaryKey: true },
    { table: "inventory_items", name: "weight", type: "DOUBLE" },
  ];
  const queries: string[] = [];
  const plan = await planOpenWorldSql({
    request: "How many inventory items are heavier than 10?",
    columns: compiledSchema,
    modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "clarify", explanation: "Contradictory envelope.", candidates: [{ query: "SELECT COUNT(*) FROM inventory_items WHERE weight > 10", explanation: "Usable candidate." }] }),
      executeSql: async (query) => { queries.push(query); return execution(query, ["count"], [[3]]); },
    },
  });
  assert.equal(plan.action, "query");
  assert.equal(plan.selected?.source, "compiler");
  assert.match(plan.selected?.query ?? "", /COUNT\(\*\).*inventory_items.*weight.*> 10/i);
  assert.ok(queries.some((query) => /inventory_items/.test(query)));
});

test("compiles generic same-field intersections without relationship guessing", async () => {
  const relational: DatasetColumn[] = [
    { table: "subscribers", name: "region", type: "VARCHAR" },
    { table: "contractors", name: "region", type: "VARCHAR" },
  ];
  const plan = await planOpenWorldSql({
    request: "Which regions have both subscribers and contractors?",
    columns: relational,
    modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => execution(query, ["region"], [["West"]]),
    },
  });
  assert.equal(plan.action, "query");
  assert.equal(plan.selected?.source, "compiler");
  assert.match(plan.selected?.query ?? "", /(?:subscribers.*INTERSECT.*contractors|contractors.*INTERSECT.*subscribers)/i);
});

test("keeps requested numbered fields and aligns compound entity names", async () => {
  const numbered: DatasetColumn[] = [
    { table: "postal_addresses", name: "line_1", type: "VARCHAR" },
    { table: "postal_addresses", name: "line_2", type: "VARCHAR" },
    { table: "postal_addresses", name: "line_3", type: "VARCHAR" },
  ];
  const projection = await planOpenWorldSql({
    request: "What are all postal addresses including line 1 and line 2?", columns: numbered, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["line_1", "line_2"], [["A", "B"]]) },
  });
  assert.match(projection.selected?.query ?? "", /line_1.*line_2/);
  assert.doesNotMatch(projection.selected?.query ?? "", /line_3/);

  const compound: DatasetColumn[] = [{ table: "Highschooler", name: "student_id", type: "INTEGER" }];
  const count = await planOpenWorldSql({
    request: "How many high schoolers are there?", columns: compound, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "query", explanation: "Wrong model filter.", candidates: [{ query: "SELECT COUNT(*) FROM Highschooler WHERE student_id = 9", explanation: "Wrong." }] }), executeSql: async (query) => query.includes("WHERE") ? execution(query, ["count"], [[1]]) : execution(query, ["count"], [[20]]) },
  });
  assert.equal(count.selected?.source, "compiler");
  assert.doesNotMatch(count.selected?.query ?? "", /WHERE/);
});

test("compiles paraphrased counts, output order, sort-only fields, and generic superlatives", async () => {
  const teachers: DatasetColumn[] = [
    { table: "teachers", name: "teacher_name", type: "VARCHAR" },
    { table: "teachers", name: "age", type: "INTEGER" },
  ];
  const count = await planOpenWorldSql({
    request: "What is the total count of teachers?", columns: teachers, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["count"], [[12]]) },
  });
  assert.match(count.selected?.query ?? "", /COUNT\(\*\).*teachers/i);

  const ordered = await planOpenWorldSql({
    request: "List teacher names ordered by age ascending", columns: teachers, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["teacher_name"], [["Ada"]]) },
  });
  assert.match(ordered.selected?.query ?? "", /SELECT\s+"teacher_name"\s+FROM\s+"teachers"\s+ORDER BY\s+"age"\s+ASC/i);
  assert.doesNotMatch(ordered.selected?.query ?? "", /SELECT\s+[^]*"age"\s*,/i);

  const votes: DatasetColumn[] = [
    { table: "votes", name: "vote_id", type: "INTEGER" },
    { table: "votes", name: "phone_number", type: "VARCHAR" },
    { table: "votes", name: "state", type: "VARCHAR" },
  ];
  const projection = await planOpenWorldSql({
    request: "List vote ids, phone numbers, and states from votes ordered by vote id descending", columns: votes, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["vote_id", "phone_number", "state"], [[9, "555", "CA"]]) },
  });
  assert.match(projection.selected?.query ?? "", /SELECT\s+"vote_id",\s*"phone_number",\s*"state"/i);
  assert.match(projection.selected?.query ?? "", /ORDER BY\s+"vote_id"\s+DESC/i);

  const contestants: DatasetColumn[] = [
    { table: "contestants", name: "contestant_number", type: "INTEGER" },
    { table: "contestants", name: "contestant_name", type: "VARCHAR" },
  ];
  const coordinated = await planOpenWorldSql({
    request: "List the contestant numbers and names, ordered by contestant name descending.", columns: contestants, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["contestant_number", "contestant_name"], [[1, "Zara"]]) },
  });
  assert.match(coordinated.selected?.query ?? "", /SELECT\s+"contestant_number",\s*"contestant_name"/i);
  assert.match(coordinated.selected?.query ?? "", /ORDER BY\s+"contestant_name"\s+DESC/i);

  const pets: DatasetColumn[] = [
    { table: "pets", name: "pet_type", type: "VARCHAR" },
    { table: "pets", name: "pet_age", type: "INTEGER" },
    { table: "pets", name: "weight", type: "DOUBLE" },
  ];
  const youngest = await planOpenWorldSql({
    request: "What is the weight of the youngest dog?", columns: pets, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["pets.pet_type", "dog"]]) : execution(query, ["weight"], [[8.5]]),
    },
  });
  assert.match(youngest.selected?.query ?? "", /WHERE\s+"pet_type"\s*=\s*'dog'.*ORDER BY\s+"pet_age"\s+ASC\s+LIMIT 1/i);

  const geography: DatasetColumn[] = [
    { table: "cities", name: "name", type: "VARCHAR" },
    { table: "cities", name: "population", type: "INTEGER" },
    { table: "country", name: "name", type: "VARCHAR" },
    { table: "country", name: "independence_year", type: "INTEGER" },
  ];
  const nations = await planOpenWorldSql({
    request: "Give the names of the nations that were founded after 1950.", columns: geography, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["name"], [["Example"]]) },
  });
  assert.match(nations.selected?.query ?? "", /SELECT\s+"name"\s+FROM\s+"country"\s+WHERE\s+"independence_year"\s*>\s*1950/i);
});

test("defers cross-table value constraints to relational planning and rejects invented limits", async () => {
  const featureSchema: DatasetColumn[] = [
    { table: "feature_types", name: "feature_type_code", type: "VARCHAR", primaryKey: true },
    { table: "feature_types", name: "feature_type_name", type: "VARCHAR" },
    { table: "features", name: "feature_type_code", type: "VARCHAR", references: [{ table: "feature_types", column: "feature_type_code" }] },
    { table: "features", name: "feature_name", type: "VARCHAR" },
  ];
  const correct = "SELECT ft.feature_type_name FROM feature_types ft JOIN features f ON f.feature_type_code = ft.feature_type_code WHERE f.feature_name = 'AirCon'";
  const relational = await planOpenWorldSql({
    request: "What is the feature type name for feature AirCon?", columns: featureSchema, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "query", explanation: "Use the declared relationship.", candidates: [{ query: correct, explanation: "Resolve the named feature through its type code." }] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["features.feature_name", "AirCon"]]) : execution(query, ["feature_type_name"], [["Amenity"]]),
    },
  });
  assert.equal(relational.selected?.source, "model");
  assert.equal(relational.selected?.query, correct);

  const nations: DatasetColumn[] = [
    { table: "nations", name: "nation_name", type: "VARCHAR" },
    { table: "nations", name: "independence_year", type: "INTEGER" },
  ];
  let generations = 0;
  const repaired = await planOpenWorldSql({
    request: "List nation names established after 1950", columns: nations, modelId: "development-model",
    dependencies: {
      completeJson: async () => {
        generations += 1;
        return generations === 1
          ? JSON.stringify({ decision: "query", explanation: "Candidate.", candidates: [{ query: "SELECT nation_name FROM nations WHERE independence_year > 1950 LIMIT 3", explanation: "Wrongly bounded." }] })
          : JSON.stringify({ decision: "query", explanation: "Repair.", candidates: [{ query: "SELECT nation_name FROM nations WHERE independence_year > 1950", explanation: "All matching nations." }] });
      },
      executeSql: async (query) => execution(query, ["nation_name"], [["Example"]]),
    },
  });
  assert.equal(repaired.selected?.source, "compiler");
  assert.doesNotMatch(repaired.selected?.query ?? "", /LIMIT/i);
  assert.ok(repaired.attempts.some((attempt) => attempt.source === "model" && attempt.status === "success" && !/LIMIT/i.test(attempt.query)));
});

test("compiles global extrema, grouping, negation, substring, and plural value forms", async () => {
  const areaCodes: DatasetColumn[] = [
    { table: "area_code_state", name: "area_code", type: "INTEGER" },
    { table: "area_code_state", name: "state", type: "VARCHAR" },
  ];
  const extrema = await planOpenWorldSql({
    request: "What are the maximum and minimum values of area codes?", columns: areaCodes, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["max", "min"], [[999, 100]]) },
  });
  assert.match(extrema.selected?.query ?? "", /SELECT\s+MAX\("area_code"\),\s*MIN\("area_code"\)/i);

  const pets: DatasetColumn[] = [
    { table: "pets", name: "pet_type", type: "VARCHAR" },
    { table: "pets", name: "weight", type: "DOUBLE" },
  ];
  const grouped = await planOpenWorldSql({
    request: "Find the maximum weight for each type of pet. List the maximum weight and pet type.", columns: pets, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["max", "pet_type"], [[12, "dog"]]) },
  });
  assert.match(grouped.selected?.query ?? "", /SELECT\s+MAX\("weight"\),\s*"pet_type"\s+FROM\s+"pets"\s+GROUP BY\s+"pet_type"/i);

  const countries: DatasetColumn[] = [
    { table: "country", name: "name", type: "VARCHAR" },
    { table: "country", name: "government_form", type: "VARCHAR" },
    { table: "country", name: "region", type: "VARCHAR" },
    { table: "country", name: "surface_area", type: "DOUBLE" },
  ];
  const republics = await planOpenWorldSql({
    request: "How many countries have governments that are republics?", columns: countries, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["country.government_form", "Republic"]]) : execution(query, ["count"], [[4]]),
    },
  });
  assert.match(republics.selected?.query ?? "", /COUNT\(\*\).*"government_form"\s*=\s*'Republic'/i);

  const surface = await planOpenWorldSql({
    request: "What is the total surface area of the countries in the Caribbean region?", columns: countries, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["country.region", "Caribbean"]]) : execution(query, ["sum"], [[42]]),
    },
  });
  assert.match(surface.selected?.query ?? "", /SUM\("surface_area"\).*WHERE\s+"region"\s*=\s*'Caribbean'/i);

  const conductors: DatasetColumn[] = [
    { table: "conductors", name: "name", type: "VARCHAR" },
    { table: "conductors", name: "nationality", type: "VARCHAR" },
  ];
  const exclusion = await planOpenWorldSql({
    request: "What are the names of conductors whose nationalities are not USA?", columns: conductors, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["conductors.nationality", "USA"]]) : execution(query, ["name"], [["Ada"]]),
    },
  });
  assert.match(exclusion.selected?.query ?? "", /SELECT\s+"name".*WHERE\s+"nationality"\s*!=\s*'USA'/i);
});

test("keeps coordinated projection order and compiles substring and superlative constraints", async () => {
  const documents: DatasetColumn[] = [
    { table: "documents", name: "document_id", type: "INTEGER" },
    { table: "documents", name: "template_id", type: "INTEGER" },
    { table: "documents", name: "document_name", type: "VARCHAR" },
    { table: "documents", name: "document_description", type: "VARCHAR" },
  ];
  const fields = await planOpenWorldSql({
    request: "What are the ids, names, and descriptions for all documents?", columns: documents, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["id", "name", "description"], [[1, "A", "B"]]) },
  });
  assert.match(fields.selected?.query ?? "", /SELECT\s+"document_id",\s*"document_name",\s*"document_description"/i);

  const contains = await planOpenWorldSql({
    request: "What is the document name and template id for a document with description containing the letter 'w'?", columns: documents, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["documents.document_description", "w"]]) : execution(query, ["name", "template_id"], [["A", 1]]),
    },
  });
  assert.match(contains.selected?.query ?? "", /SELECT\s+"document_name",\s*"template_id"/i);
  assert.doesNotMatch(contains.selected?.query ?? "", /SELECT[^]*"document_id"/i);
  assert.match(contains.selected?.query ?? "", /"document_description"\s+LIKE\s+'%w%'/i);

  const unquoted = await planOpenWorldSql({
    request: "Return the document names and template ids for documents that contain the letter w in their description.", columns: documents, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["document_name", "template_id"], [["A", 1]]) },
  });
  assert.match(unquoted.selected?.query ?? "", /SELECT\s+"document_name",\s*"template_id".*"document_description"\s+LIKE\s+'%w%'/i);

  const museums: DatasetColumn[] = [
    { table: "museums", name: "museum_id", type: "INTEGER" },
    { table: "museums", name: "name", type: "VARCHAR" },
    { table: "museums", name: "number_of_staff", type: "INTEGER" },
  ];
  const most = await planOpenWorldSql({
    request: "Find the id and name of the museum that has the most staff members", columns: museums, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["museum_id", "name"], [[1, "A"]]) },
  });
  assert.match(most.selected?.query ?? "", /SELECT\s+"museum_id",\s*"name".*ORDER BY\s+"number_of_staff"\s+DESC\s+LIMIT 1/i);

  const visitors: DatasetColumn[] = [
    { table: "visitors", name: "name", type: "VARCHAR" },
    { table: "visitors", name: "membership_level", type: "INTEGER" },
    { table: "visitors", name: "age", type: "INTEGER" },
  ];
  const scoped = await planOpenWorldSql({
    request: "Find the name and membership level of visitors whose membership level is higher than 4, and sort by age from old to young.", columns: visitors, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["name", "membership_level"], [["A", 5]]) },
  });
  assert.match(scoped.selected?.query ?? "", /WHERE\s+"membership_level"\s*>\s*4.*ORDER BY\s+"age"\s+DESC/i);
});

test("bounds overlong planner prose without discarding a valid query", async () => {
  const plan = await planOpenWorldSql({
    request: "How many accounts are listed?", columns: [{ table: "accounts", name: "account_id", type: "INTEGER" }], modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "query", explanation: "x".repeat(2_000), candidates: [{ query: "SELECT COUNT(*) FROM accounts", explanation: "y".repeat(2_000) }] }),
      executeSql: async (query) => execution(query, ["count"], [[1]]),
    },
  });
  assert.equal(plan.action, "query");
  assert.ok(plan.explanation.length <= 600);
});

test("resolves display-title aliases, grouped-count order, and descriptive model filters", async () => {
  const cartoons: DatasetColumn[] = [
    { table: "cartoons", name: "title", type: "VARCHAR" },
    { table: "cartoons", name: "directed_by", type: "VARCHAR" },
  ];
  const titles = await planOpenWorldSql({
    request: "What are the names of all cartoons directed by Ben Jones?", columns: cartoons, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["cartoons.directed_by", "Ben Jones"]]) : execution(query, ["title"], [["Example"]]),
    },
  });
  assert.match(titles.selected?.query ?? "", /SELECT\s+"title".*WHERE\s+"directed_by"\s*=\s*'Ben Jones'/i);

  const employees: DatasetColumn[] = [
    { table: "employees", name: "employee_id", type: "INTEGER" },
    { table: "employees", name: "city", type: "VARCHAR" },
  ];
  const grouped = await planOpenWorldSql({
    request: "What is the number of employees from each city?", columns: employees, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["count", "city"], [[2, "Boston"]]) },
  });
  assert.match(grouped.selected?.query ?? "", /SELECT\s+COUNT\(\*\),\s*"city".*GROUP BY\s+"city"/i);

  const singers: DatasetColumn[] = [
    { table: "singers", name: "age", type: "INTEGER" },
    { table: "singers", name: "country", type: "VARCHAR" },
  ];
  const correct = "SELECT AVG(age), MIN(age), MAX(age) FROM singers WHERE country = 'France'";
  const filtered = await planOpenWorldSql({
    request: "What is the average, minimum, and maximum age for all French singers?", columns: singers, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "query", explanation: "Resolve the nationality adjective.", candidates: [{ query: correct, explanation: "Filter the singer population to France." }] }),
      executeSql: async (query) => query === correct ? execution(query, ["avg", "min", "max"], [[40, 20, 60]]) : execution(query, ["avg", "min", "max"], [[45, 20, 70]]),
    },
  });
  assert.equal(filtered.selected?.source, "model");
  assert.equal(filtered.selected?.query, correct);
});

test("compiles declared-key related-entity existence and count alternatives", async () => {
  const relational: DatasetColumn[] = [
    { table: "dogs", name: "dog_id", type: "INTEGER", primaryKey: true },
    { table: "dogs", name: "age", type: "VARCHAR" },
    { table: "treatments", name: "treatment_id", type: "INTEGER" },
    { table: "treatments", name: "dog_id", type: "INTEGER", references: [{ table: "dogs", column: "dog_id" }] },
  ];
  const query = "SELECT AVG(TRY_CAST(d.age AS DOUBLE)) FROM dogs d WHERE d.dog_id IN (SELECT t.dog_id FROM treatments t)";
  const plan = await planOpenWorldSql({
    request: "Find the average age of the dogs who went through treatments.", columns: relational, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "query", explanation: "Use the declared treatment relationship.", candidates: [{ query, explanation: "Average treated dogs after a safe numeric cast." }] }),
      executeSql: async (candidate) => execution(candidate, ["avg"], [[4.5]]),
    },
  });
  assert.equal(plan.selected?.source, "compiler");
  assert.match(plan.selected?.query ?? "", /AVG\(TRY_CAST\(t\."age" AS DOUBLE\)\).*FROM\s+"dogs"\s+AS t.*EXISTS.*FROM\s+"treatments"\s+AS r.*r\."dog_id"\s*=\s*t\."dog_id"/i);

  const professionals: DatasetColumn[] = [
    { table: "professionals", name: "professional_id", type: "INTEGER", primaryKey: true },
    { table: "professionals", name: "last_name", type: "VARCHAR" },
    { table: "professionals", name: "cell_number", type: "VARCHAR" },
    { table: "professionals", name: "state", type: "VARCHAR" },
    { table: "treatments", name: "treatment_id", type: "INTEGER" },
    { table: "treatments", name: "professional_id", type: "INTEGER", references: [{ table: "professionals", column: "professional_id" }] },
  ];
  const alternatives = await planOpenWorldSql({
    request: "Which professionals live in the state of Indiana or have done treatment on more than two treatments? List his or her id, last name and cell phone.", columns: professionals, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (candidate) => candidate.includes('AS "field"') ? execution(candidate, ["field", "value"], [["professionals.state", "Indiana"]]) : execution(candidate, ["professional_id", "last_name", "cell_number"], [[1, "A", "555"]]),
    },
  });
  assert.equal(alternatives.selected?.source, "compiler");
  assert.match(alternatives.selected?.query ?? "", /FROM\s+"professionals"\s+AS t\s+WHERE\s+t\."state"\s*=\s*'Indiana'\s+UNION/i);
  assert.match(alternatives.selected?.query ?? "", /JOIN\s+"treatments"\s+AS r.*HAVING\s+COUNT\(\*\)\s*>\s*2/i);
});

test("separates count intent, numeric scope, projections, and declared-key filters", async () => {
  const museums: DatasetColumn[] = [
    { table: "museum", name: "Museum_ID", type: "INTEGER", primaryKey: true },
    { table: "museum", name: "Name", type: "VARCHAR" },
    { table: "museum", name: "Num_of_Staff", type: "INTEGER" },
    { table: "museum", name: "Open_Year", type: "INTEGER" },
  ];
  const average = await planOpenWorldSql({
    request: "Find the average number of staff working for the museums that were open before 2009.", columns: museums, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["museum.Open_Year", "2009"]]) : execution(query, ["avg"], [[12]]),
    },
  });
  assert.match(average.selected?.query ?? "", /AVG\("Num_of_Staff"\).*"Open_Year"\s*<\s*2009/i);
  assert.doesNotMatch(average.selected?.query ?? "", /"Num_of_Staff"\s*</i);
  assert.doesNotMatch(average.selected?.query ?? "", /"Open_Year"\s*=\s*'2009'/i);

  const museumFields = await planOpenWorldSql({
    request: "What are the opening year and staff number of the museum named Plaza Museum?", columns: museums, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["museum.Name", "Plaza Museum"]]) : execution(query, ["Open_Year", "Num_of_Staff"], [[2008, 10]]),
    },
  });
  assert.match(museumFields.selected?.query ?? "", /SELECT\s+"Open_Year",\s*"Num_of_Staff".*WHERE\s+"Name"\s*=\s*'Plaza Museum'/i);
  assert.doesNotMatch(museumFields.selected?.query ?? "", /COUNT\s*\(/i);

  const relationships: DatasetColumn[] = [
    { table: "death", name: "caused_by_ship_id", type: "INTEGER", references: [{ table: "ship", column: "id" }] },
    { table: "death", name: "killed", type: "INTEGER" },
    { table: "death", name: "injured", type: "INTEGER" },
    { table: "ship", name: "id", type: "INTEGER", primaryKey: true },
    { table: "ship", name: "tonnage", type: "VARCHAR" },
  ];
  const joined = await planOpenWorldSql({
    request: "What are the death and injury situations caused by the ship with tonnage 't'?", columns: relationships, modelId: "development-model",
    dependencies: {
      completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }),
      executeSql: async (query) => query.includes('AS "field"') ? execution(query, ["field", "value"], [["ship.tonnage", "t"]]) : execution(query, ["killed", "injured"], [[1, 2]]),
    },
  });
  assert.match(joined.selected?.query ?? "", /SELECT\s+t\."killed",\s*t\."injured".*JOIN\s+"ship"\s+AS r.*t\."caused_by_ship_id"\s*=\s*r\."id".*r\."tonnage"\s*=\s*'t'/i);
});

test("keeps compound outputs, distinctness, and removes only an unsupported trailing limit", async () => {
  const singers: DatasetColumn[] = [
    { table: "singer", name: "Name", type: "VARCHAR" },
    { table: "singer", name: "Song_Name", type: "VARCHAR" },
    { table: "singer", name: "Song_release_year", type: "INTEGER" },
    { table: "singer", name: "Age", type: "INTEGER" },
  ];
  const song = await planOpenWorldSql({
    request: "Show the name and the release year of the song by the youngest singer.", columns: singers, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["Song_Name", "Song_release_year"], [["A", 2000]]) },
  });
  assert.match(song.selected?.query ?? "", /SELECT\s+"Song_Name",\s*"Song_release_year".*ORDER BY\s+"Age"\s+ASC\s+LIMIT 1/i);
  assert.doesNotMatch(song.selected?.query ?? "", /SELECT[^]*"Name"/i);

  const votes: DatasetColumn[] = [
    { table: "votes", name: "state", type: "VARCHAR" },
    { table: "votes", name: "created", type: "VARCHAR" },
  ];
  const distinct = await planOpenWorldSql({
    request: "What are the distinct states and create time of all votes?", columns: votes, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["state", "created"], [["CA", "now"]]) },
  });
  assert.match(distinct.selected?.query ?? "", /SELECT\s+DISTINCT\s+"state",\s*"created"/i);

  const crossTable: DatasetColumn[] = [
    { table: "makers", name: "maker_id", type: "INTEGER", primaryKey: true },
    { table: "makers", name: "full_name", type: "VARCHAR" },
    { table: "models", name: "maker_id", type: "INTEGER", references: [{ table: "makers", column: "maker_id" }] },
  ];
  const bounded = "SELECT m.full_name, COUNT(*) FROM makers m JOIN models x ON x.maker_id = m.maker_id GROUP BY m.full_name LIMIT 10";
  const sanitized = await planOpenWorldSql({
    request: "How many models does each maker produce? List the maker full name and number.", columns: crossTable, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "query", explanation: "Count models per maker.", candidates: [{ query: bounded, explanation: "Count related model rows." }] }), executeSql: async (query) => execution(query, ["full_name", "count"], [["A", 2]]) },
  });
  assert.equal(sanitized.selected?.source, "compiler");
  assert.match(sanitized.selected?.query ?? "", /JOIN\s+"models".*GROUP BY/i);
  assert.doesNotMatch(sanitized.selected?.query ?? "", /\bLIMIT\b/i);
});

test("compiles row filters before group thresholds and coordinates repeated aggregates", async () => {
  const employees: DatasetColumn[] = [
    { table: "employee", name: "Employee_ID", type: "INTEGER", primaryKey: true },
    { table: "employee", name: "City", type: "VARCHAR" },
    { table: "employee", name: "Age", type: "INTEGER" },
  ];
  const grouped = await planOpenWorldSql({
    request: "Which cities do more than one employee under age 30 come from?", columns: employees, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["City"], [["Boston"]]) },
  });
  assert.match(grouped.selected?.query ?? "", /SELECT\s+"City".*WHERE\s+"Age"\s*<\s*30.*GROUP BY\s+"City".*HAVING\s+COUNT\(\*\)\s*>\s*1/i);

  const matches: DatasetColumn[] = [
    { table: "matches", name: "winner_age", type: "INTEGER" },
    { table: "matches", name: "loser_age", type: "INTEGER" },
    { table: "matches", name: "winner_id", type: "INTEGER" },
    { table: "matches", name: "loser_id", type: "INTEGER" },
  ];
  const averages = await planOpenWorldSql({
    request: "Find the average age of losers and winners across matches.", columns: matches, modelId: "development-model",
    dependencies: { completeJson: async () => JSON.stringify({ decision: "unavailable", explanation: "No model candidate.", candidates: [] }), executeSql: async (query) => execution(query, ["loser", "winner"], [[31, 29]]) },
  });
  assert.match(averages.selected?.query ?? "", /SELECT\s+AVG\("loser_age"\),\s*AVG\("winner_age"\)\s+FROM\s+"matches"/i);
  assert.doesNotMatch(averages.selected?.query ?? "", /GROUP BY|CASE/i);
});
