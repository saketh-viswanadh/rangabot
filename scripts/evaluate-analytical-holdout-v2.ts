import { runAnalyticalHoldout, type AnalyticalHoldoutDefinition } from "./analytical-holdout-runner.ts";

const definition: AnalyticalHoldoutDefinition = {
  suite: "analytical-holdout-v2",
  frozenAt: "2026-08-03",
  databaseName: "analytical-holdout-v2.duckdb",
  setupSql: `
    CREATE TABLE members AS SELECT i::INTEGER member_id, CASE i % 3 WHEN 0 THEN 'Riverside' WHEN 1 THEN 'Old Town' ELSE 'Garden' END district, (i % 6 <> 0) enrolled FROM range(1, 22) t(i);
    CREATE TABLE books AS SELECT i::INTEGER book_id, CASE i % 4 WHEN 0 THEN 'Science' WHEN 1 THEN 'History' WHEN 2 THEN 'Fiction' ELSE 'Art' END genre FROM range(1, 17) t(i);
    CREATE TABLE loans AS SELECT i::INTEGER loan_id, ((i * 5) % 21 + 1)::INTEGER member_id, ((i * 7) % 16 + 1)::INTEGER book_id, TIMESTAMP '2025-03-01 09:00:00' + i * INTERVAL '9 hours' borrowed_at, TIMESTAMP '2025-03-01 09:00:00' + i * INTERVAL '9 hours' + (1 + i % 12) * INTERVAL '1 day' returned_at, DATE '2025-03-01' + ((i * 2) % 61)::INTEGER loan_date, (20 + (i * 13) % 380)::DOUBLE pages_read, (i % 8)::DOUBLE late_fee FROM range(1, 141) t(i);
    CREATE TABLE events AS SELECT i::INTEGER event_id, ((i * 8) % 21 + 1)::INTEGER member_id, DATE '2025-03-01' + (i * 3)::INTEGER event_date, (i % 5 <> 0) attended FROM range(1, 31) t(i);
  `,
  cases: [
    { id: "lb-01", question: "What is the total pages_read across all loans?", goldSql: "SELECT SUM(pages_read) FROM loans" },
    { id: "lb-02", question: "What is the average late_fee per loan?", goldSql: "SELECT AVG(late_fee) FROM loans" },
    { id: "lb-03", question: "Show total pages_read by district.", goldSql: "SELECT district, SUM(pages_read) FROM loans JOIN members USING (member_id) GROUP BY district" },
    { id: "lb-04", question: "Show the top 3 genres by total pages_read.", goldSql: "SELECT genre, SUM(pages_read) value FROM loans JOIN books USING (book_id) GROUP BY genre ORDER BY value DESC LIMIT 3" },
    { id: "lb-05", question: "How many enrolled members are there?", goldSql: "SELECT COUNT(*) FROM members WHERE enrolled = TRUE" },
    { id: "lb-06", question: "What is the average duration between borrowed_at and returned_at in hours?", goldSql: "SELECT AVG(DATE_DIFF('minute', borrowed_at, returned_at)) / 60.0 FROM loans" },
    { id: "lb-07", question: "What is the ratio of total pages_read divided by total late_fee?", goldSql: "SELECT SUM(pages_read) / NULLIF(SUM(late_fee), 0) FROM loans" },
    { id: "lb-08", question: "How many members have at least 4 loans?", goldSql: "SELECT COUNT(*) FROM (SELECT member_id FROM loans GROUP BY member_id HAVING COUNT(*) >= 4) q" },
    { id: "lb-09", question: "What is the average total pages_read per member?", goldSql: "SELECT AVG(value) FROM (SELECT member_id, SUM(pages_read) value FROM loans GROUP BY member_id) q" },
    { id: "lb-10", question: "Which members were never linked to events?", goldSql: "SELECT member_id FROM members LEFT JOIN events USING (member_id) WHERE event_id IS NULL ORDER BY member_id" },
    { id: "lb-11", question: "What was the percentage growth in total pages_read from March 2025 to April 2025?", goldSql: "WITH p AS (SELECT SUM(pages_read) FILTER (WHERE loan_date >= DATE '2025-03-01' AND loan_date < DATE '2025-04-01') a, SUM(pages_read) FILTER (WHERE loan_date >= DATE '2025-04-01' AND loan_date < DATE '2025-05-01') b FROM loans) SELECT 100.0 * (b-a) / NULLIF(a,0) FROM p" },
    { id: "lb-12", question: "Which district is best?", boundary: "clarify" },
  ],
};

await runAnalyticalHoldout(definition);
