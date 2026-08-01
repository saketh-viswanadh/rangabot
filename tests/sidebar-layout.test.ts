import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
const icons = readFileSync("app/components/craft-icon.tsx", "utf8");
const sidebar = page.slice(page.indexOf('<aside className="sidebar">'), page.indexOf('</aside>'));
const header = page.slice(page.indexOf('<section className="chat-panel">'), page.indexOf('<div\n          className="messages"'));

test("keeps the sidebar focused on chats", () => {
  assert.match(sidebar, /Projects/);
  assert.match(sidebar, /conversation-search/);
  assert.match(sidebar, /className="history"/);
  assert.doesNotMatch(sidebar, /Knowledge Brief|Path to Mastery|Local memory|Local repositories/);
});

test("places secondary tools in the compact header utility rail", () => {
  assert.match(header, /className="utility-rail"/);
  assert.match(header, />Brief</);
  assert.match(header, />Memory</);
  assert.match(header, />Mastery</);
  assert.match(header, />Folders</);
  assert.match(header, /repository-popover/);
  assert.match(header, /privacy-indicator/);
});

test("keeps chat titles primary and reveals actions only on focus", () => {
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 0 0/);
  assert.match(styles, /\.history:has\(\.history-row:hover\)/);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(styles, /\.history-row:hover \.delete-chat/);
});

test("uses layered hand-drawn collection and folder marks", () => {
  assert.match(icons, /chat: <><path[^>]+\/><path/);
  assert.match(icons, /folder: <><path[^>]+\/><path/);
});
