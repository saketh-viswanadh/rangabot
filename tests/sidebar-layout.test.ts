import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/page.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
const icons = readFileSync("app/components/craft-icon.tsx", "utf8");
const sidebar = page.slice(page.indexOf('<aside id="chat-navigation"'), page.indexOf('</aside>'));
const chatPanelStart = page.indexOf("<section className={`chat-panel");
const messagesStart = page.indexOf('className="messages"', chatPanelStart);

assert.notEqual(chatPanelStart, -1, "Missing chat panel");
assert.notEqual(messagesStart, -1, "Missing messages region after chat panel");

const header = page.slice(chatPanelStart, messagesStart);

test("keeps the sidebar focused on chats", () => {
  assert.match(sidebar, /Projects/);
  assert.match(sidebar, /conversation-search/);
  assert.match(sidebar, /className="history"/);
  assert.doesNotMatch(sidebar, /Knowledge Brief|Path to Mastery|Local memory|Local repositories/);
  assert.doesNotMatch(sidebar, /Cmd K|<kbd>/, "The search control must not advertise an unimplemented shortcut");
});

test("keeps recent chats visible and supports project drag and drop", () => {
  assert.doesNotMatch(page, /parameters\.set\("projectId", activeProjectId\)/,
    "Selecting or creating a project must not filter recent chats out of the sidebar");
  assert.match(sidebar, /draggable/);
  assert.match(sidebar, /onDragStart/);
  assert.match(sidebar, /onDrop=\{\(event\) => dropConversation\(event, project\.id\)\}/);
  assert.match(sidebar, /onDrop=\{\(event\) => dropConversation\(event, null\)\}/);
  assert.match(sidebar, /Drag a chat onto a project—or All chats—to move it/);
  assert.match(styles, /\.project-item\.conversation-drop-target/);
  assert.match(styles, /\.history-row\.dragging/);
});

test("places secondary tools in one compact, disclosed workbench", () => {
  assert.match(header, /className="tools-menu"/);
  assert.match(header, /aria-label="Conversation and workspace options"/);
  assert.match(header, /<strong>Knowledge<\/strong>/);
  assert.match(header, /<strong>Memory<\/strong>/);
  assert.match(header, /<strong>Models<\/strong>/);
  assert.match(header, /> Folders</);
  assert.match(header, /tools-popover/);
  assert.match(header, /> Settings</);
});

test("keeps chats and projects reachable through a real mobile drawer", () => {
  assert.match(header, /className="mobile-navigation"/);
  assert.match(header, /aria-controls="chat-navigation"/);
  assert.match(styles, /\.sidebar \{[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*transform: translateX\(-105%\);/);
  assert.match(styles, /\.sidebar\.open \{[^}]*visibility: visible;[^}]*pointer-events: auto;[^}]*transform: translateX\(0\);/);
  assert.match(styles, /\.sidebar-backdrop/);
  assert.doesNotMatch(styles, /\.sidebar \{ display: none; \}/);
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
