import { ingest } from "./pipeline.js";

export function handle(id: string): string {
  return ingest(id).state;
}
