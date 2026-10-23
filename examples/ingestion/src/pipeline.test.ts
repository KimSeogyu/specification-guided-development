import { Document } from "./pipeline.js";
import { Storage } from "./storage.js";

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function rejects(operation: () => void, message: string): void {
  try { operation(); } catch { return; }
  throw new Error(message);
}

const storage = new Storage();
const document = new Document("accepted");
rejects(() => document.persist(storage), "Received must refuse Persist");
expect(document.state === "Received", "Refused Persist must preserve Received");
expect(!storage.ids.has(document.id), "Refused Persist must not store the document");
document.validate();
expect(document.state === "Validated", "Validate must produce Validated");
rejects(() => document.validate(), "Validated must refuse Validate");
expect(document.state === "Validated", "Refused Validate must preserve Validated");
rejects(() => document.reject(), "Validated must refuse Reject");
expect(document.state === "Validated", "Refused Reject must preserve Validated");
document.persist(storage);
expect(document.state === "Stored", "Persist must produce Stored");
expect(storage.ids.has(document.id), "Persist must store the document");
for (const [action, operation] of [
  ["Validate", () => document.validate()],
  ["Persist", () => document.persist(storage)],
  ["Reject", () => document.reject()],
] as const) {
  rejects(operation, `Stored must refuse ${action}`);
  expect(document.state === "Stored", `Refused ${action} must preserve Stored`);
  expect(storage.ids.has(document.id), `Refused ${action} must preserve stored IDs`);
}

const rejected = new Document("rejected");
rejected.reject();
expect(rejected.state === "Rejected", "Reject must produce Rejected");
for (const [action, operation] of [
  ["Validate", () => rejected.validate()],
  ["Persist", () => rejected.persist(storage)],
  ["Reject", () => rejected.reject()],
] as const) {
  rejects(operation, `Rejected must refuse ${action}`);
  expect(rejected.state === "Rejected", `Refused ${action} must preserve Rejected`);
  expect(!storage.ids.has(rejected.id), `Refused ${action} must not store rejected IDs`);
}
console.log("TypeScript ingestion runtime tests passed");
