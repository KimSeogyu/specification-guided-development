export class Storage {
  readonly ids = new Set<string>();

  save(id: string): void {
    this.ids.add(id);
  }
}
