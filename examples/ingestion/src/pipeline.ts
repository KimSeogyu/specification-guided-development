import { Storage } from "./storage.js";

type State = "Received" | "Validated" | "Stored" | "Rejected";
function transition(_from: State, _action: string, _to: State): void {}

export class Document {
  #state: State = "Received";
  constructor(readonly id: string) {}
  get state(): State { return this.#state; }

  validate(): void {
    if (this.#state !== "Received") throw new Error("Validate requires Received");
    transition("Received", "Validate", "Validated");
    this.#state = "Validated";
  }

  persist(storage: Storage): void {
    if (this.#state !== "Validated") throw new Error("Persist requires Validated");
    transition("Validated", "Persist", "Stored");
    storage.save(this.id);
    this.#state = "Stored";
  }

  reject(): void {
    if (this.#state !== "Received") throw new Error("Reject requires Received");
    transition("Received", "Reject", "Rejected");
    this.#state = "Rejected";
  }
}

export function ingest(id: string): Document {
  const document = new Document(id);
  const storage = new Storage();
  document.validate();
  document.persist(storage);
  return document;
}
