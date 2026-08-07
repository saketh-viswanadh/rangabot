import assert from "node:assert/strict";
import test from "node:test";
import { chooseGreetingIndex, formatWelcomeGreeting, welcomeGreetings } from "../lib/welcome-greeting.ts";

test("rotates to a different greeting and formats an optional local name", () => {
  assert.ok(welcomeGreetings.length >= 8);
  assert.equal(chooseGreetingIndex(0, () => 0), 1);
  assert.equal(formatWelcomeGreeting(0, "Ranga"), "Hi, Ranga.");
  assert.equal(formatWelcomeGreeting(0, ""), "Hi.");
});

test("keeps greeting templates bounded and complete", () => {
  for (const greeting of welcomeGreetings) {
    assert.ok(greeting.withName.includes("{name}"));
    assert.ok(greeting.withName.length <= 80);
    assert.ok(greeting.withoutName.length <= 60);
  }
});
