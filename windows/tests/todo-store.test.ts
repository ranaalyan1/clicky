import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TodoStore } from "../src/main/todo-store";

function createTodoStore(): TodoStore {
  return new TodoStore(join(mkdtempSync(join(tmpdir(), "clickaa-todo-")), "todos.json"));
}

test("todos can be added, completed, reopened and removed", () => {
  const todoStore = createTodoStore();
  const addedTodo = todoStore.add("call mom at six", "2026-10-14T18:00");

  assert.equal(todoStore.list().length, 1);
  assert.equal(addedTodo.dueAt, "2026-10-14T18:00");

  todoStore.setDone(addedTodo.id, true);
  assert.equal(todoStore.list()[0]?.isDone, true);

  todoStore.completeMatching("call mom");
  assert.equal(todoStore.list().filter((todoItem) => !todoItem.isDone).length, 0);

  todoStore.reopenMatching("call mom");
  assert.equal(todoStore.list()[0]?.isDone, false);

  assert.equal(todoStore.remove(addedTodo.id), true);
  assert.equal(todoStore.list().length, 0);
});

test("matching items are found by fuzzy words and removal reports what it removed", () => {
  const todoStore = createTodoStore();
  todoStore.add("buy oat milk", null);
  todoStore.add("ship the clickaa installer", null);

  const matchedItems = todoStore.completeMatching("oat milk");
  assert.equal(matchedItems.length, 1);
  assert.equal(matchedItems[0]?.text, "buy oat milk");

  const removedItems = todoStore.removeMatching("installer");
  assert.equal(removedItems.length, 1);

  const unmatched = todoStore.findMatches("taxes");
  assert.equal(unmatched.matches.length, 0);
  assert.equal(unmatched.isAmbiguous, false);
});

test("open items are summarized with counts and the store survives a reload", () => {
  const todoFilePath = join(mkdtempSync(join(tmpdir(), "clickaa-todo-")), "todos.json");
  const firstStore = new TodoStore(todoFilePath);
  const addedTodo = firstStore.add("water the plants", null);
  firstStore.add("pay the internet bill", null);
  firstStore.setDone(addedTodo.id, true);

  const summary = firstStore.summarizeOpenItems(5);
  assert.deepEqual(summary, ["pay the internet bill"]);
  assert.equal(firstStore.clearDone(), 1);

  const reloadedStore = new TodoStore(todoFilePath);
  assert.deepEqual(
    reloadedStore.list().map((todoItem) => todoItem.text),
    ["pay the internet bill"],
  );
});
