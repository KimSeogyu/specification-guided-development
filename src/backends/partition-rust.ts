import { validatePartitionPlan } from '../partition-composition.js';
import type { PartitionBackendInput } from '../partition-types.js';
import type { GeneratedFile } from '../types.js';
import { generateOwnedRust } from './owned-rust.js';
import { generateRowRust } from './row-rust.js';

function quoted(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code >= 0xd800 && code <= 0xdfff) throw new Error('PART301: Rust strings require Unicode scalar values');
    result += character === '"' ? '\\"' : character === '\\' ? '\\\\' : code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : character;
  }
  return result + '"';
}

function beforeGeneratedTests(source: string, addition: string): string {
  const boundary = source.indexOf('\n#[cfg(test)]\nmod tests {');
  if (boundary < 0) throw new Error('PART301: generated primitive test boundary is absent');
  return source.slice(0, boundary) + '\n' + addition + source.slice(boundary);
}

/** Emit an unbound collection fold. Its consumed report grants no IO permission. */
export function generatePartitionRust(input: PartitionBackendInput): GeneratedFile[] {
  const plan = validatePartitionPlan(input.plan);
  const controlClass = `${input.className}Control`;
  const controlFiles = generateOwnedRust({ automaton: plan.control, className: controlClass });
  const controlLibrary = controlFiles.find(file => file.path === 'src/lib.rs');
  if (!controlLibrary) throw new Error('PART301: finite controller library is absent');
  const controlSource = beforeGeneratedTests(controlLibrary.content, `impl Default for ${controlClass} { fn default() -> Self { Self::new() } }\n`);
  const closeEdges = plan.control.edges.filter(edge => edge.event.startsWith('Close'));
  const consumeEdges = plan.control.edges.filter(edge => edge.event.startsWith('Consume'));
  const closeChoices = [...new Map(closeEdges.map(edge => [edge.from, edge])).values()]
    .map(edge => `        ${quoted(edge.from)} => Some(control::Event::${edge.event}),`).join('\n');
  const consumeChoices = [...new Map(consumeEdges.map(edge => [edge.from, edge])).values()]
    .map(edge => `        ${quoted(edge.from)} => Some((control::Event::${edge.event}, ReportKind::${edge.event.slice('Consume'.length)})),`).join('\n');
  const projections = plan.contract.families.map(family => {
    const fact = plan.row.plan.facts.find(candidate => candidate.name === family.name);
    if (!fact) throw new Error('PART301: checked family source is absent');
    const expression = (name: string): string => {
      const field = fact.fields.find(candidate => candidate.name === name);
      if (!field) throw new Error('PART301: checked projection field is absent');
      return `self.${field.name}${field.codec.getters.map(getter => `.${getter}()`).join('')}`;
    };
    const symbol = fact.fields.find(field => field.name === family.symbol);
    if (!symbol) throw new Error('PART301: checked symbol field is absent');
    const key = [...family.key.map(expression), ...Array.from({ length: 3 - family.key.length }, () => '0')].join(', ');
    return `impl PartitionFact for ${fact.rustPath} {}
impl partition_sealed::Projection for ${fact.rustPath} {
    fn partition_key(&self) -> [i64; 3] { [${key}] }
    fn partition_symbol(&self) -> &str { ${symbol.codec.getters.length ? expression(family.symbol) : '&' + expression(family.symbol)} }
    fn partition_time(&self) -> i64 { ${expression(family.time)} }
}`;
  }).join('\n\n');
  const adapterExtension = `
// Closed collection runtime. Keys never cross a sealed Fact family: padding to
// three components preserves the exact signed tuple ordering for that family.
use authority::partition_control as control;
use std::collections::BTreeMap;

mod partition_sealed {
    pub trait Projection {
        fn partition_key(&self) -> [i64; 3];
        fn partition_symbol(&self) -> &str;
        fn partition_time(&self) -> i64;
    }
}

// The private supertrait prevents callers from supplying key or grouping policy.
pub(crate) trait PartitionFact: BoundFact + partition_sealed::Projection {}

${projections}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PartitionCounts {
    inserted: u64,
    unchanged: u64,
}
impl PartitionCounts {
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn inserted(self) -> u64 { self.inserted }
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn unchanged(self) -> u64 { self.unchanged }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PartitionGroup {
    symbol: String,
    day_index: i64,
}
impl PartitionGroup {
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn symbol(&self) -> &str { &self.symbol }
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn day_index(&self) -> i64 { self.day_index }
}

#[derive(Clone, Debug)]
pub(crate) struct PartitionConflict<T: PartitionFact> {
    stored: T,
    rejected: T,
}
impl<T: PartitionFact> PartitionConflict<T> {
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn stored(&self) -> &T { &self.stored }
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn rejected(&self) -> &T { &self.rejected }
    #[allow(dead_code)] // Optional consuming generated API.
    pub(crate) fn into_rows(self) -> (T, T) { (self.stored, self.rejected) }
}

#[derive(Debug)]
pub(crate) enum PartitionError {
    Row(RowError),
    Control(control::TransitionError),
    NegativeTime,
    MixedGroup,
    CountExhausted,
    BrokenComposition,
}
impl std::fmt::Display for PartitionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Row(error) => write!(formatter, "{error}"),
            Self::Control(error) => write!(formatter, "{error}"),
            Self::NegativeTime => formatter.write_str("PART302: partition time must be a nonnegative i64 microsecond value"),
            Self::MixedGroup => formatter.write_str("PART303: baseline and incoming rows must share one exact symbol and UTC day index"),
            Self::CountExhausted => formatter.write_str("PART304: partition observation count is exhausted"),
            Self::BrokenComposition => formatter.write_str("PART305: generated row and partition control disagree; regenerate from the verified composition"),
        }
    }
}
impl std::error::Error for PartitionError {}

#[derive(Clone, Copy)]
enum ReportKind { Write, Noop, Refused }

fn close_event(node: &str) -> Option<control::Event> {
    match node {
${closeChoices}
        _ => None,
    }
}
fn consume_event(node: &str) -> Option<(control::Event, ReportKind)> {
    match node {
${consumeChoices}
        _ => None,
    }
}

// This checks consistency within the supplied data only. A path, dataset, loaded
// baseline, external symbol selection, writer, and persistence are not bound.
fn checked_group<T: PartitionFact>(baseline: &[T], incoming: &[T]) -> Result<Option<PartitionGroup>, PartitionError> {
    let mut group: Option<PartitionGroup> = None;
    for row in baseline.iter().chain(incoming) {
        let time = row.partition_time();
        if time < 0 { return Err(PartitionError::NegativeTime); }
        let day_index = time / 86_400_000_000;
        match &group {
            Some(expected) if expected.symbol != row.partition_symbol() || expected.day_index != day_index => return Err(PartitionError::MixedGroup),
            Some(_) => {},
            None => group = Some(PartitionGroup { symbol: row.partition_symbol().to_owned(), day_index }),
        }
    }
    Ok(group)
}

/// A private trial has closed. Consuming it can only produce unbound data.
/// No raw constructor, observations, controller, Clone, restore, or IO callback.
pub(crate) struct ClosedPartition<T: PartitionFact> {
    controller: control::${controlClass},
    owners: BTreeMap<[i64; 3], FactOwner<T>>,
    original: Vec<T>,
    conflicts: Vec<PartitionConflict<T>>,
    counts: PartitionCounts,
    group: Option<PartitionGroup>,
}
impl<T: PartitionFact> ClosedPartition<T> {
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn counts(&self) -> PartitionCounts { self.counts }
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn group(&self) -> Option<&PartitionGroup> { self.group.as_ref() }

    pub(crate) fn into_report(mut self) -> Result<UnboundPartitionReport<T>, PartitionError> {
        let (event, kind) = consume_event(self.controller.read().node_id).ok_or(PartitionError::BrokenComposition)?;
        self.controller.send(event).map_err(PartitionError::Control)?;
        let group = self.group;
        let mut counts = self.counts;
        Ok(match kind {
            ReportKind::Write => {
                let rows = self.owners.into_values().map(|owner| owner.stored.ok_or(PartitionError::BrokenComposition)).collect::<Result<Vec<_>, _>>()?;
                UnboundPartitionReport::Write { rows, counts, group }
            },
            ReportKind::Noop => UnboundPartitionReport::Noop { rows: self.original, counts, group },
            ReportKind::Refused => {
                counts.inserted = 0;
                UnboundPartitionReport::Refused { original: self.original, conflicts: self.conflicts, counts, group }
            },
        })
    }
}

/// Complete ordinary data after the matching model consume edge. These values
/// grant no permission to publish, persist, overwrite, or log any external data.
#[derive(Debug)]
pub(crate) enum UnboundPartitionReport<T: PartitionFact> {
    Write { rows: Vec<T>, counts: PartitionCounts, group: Option<PartitionGroup> },
    Noop { rows: Vec<T>, counts: PartitionCounts, group: Option<PartitionGroup> },
    Refused { original: Vec<T>, conflicts: Vec<PartitionConflict<T>>, counts: PartitionCounts, group: Option<PartitionGroup> },
}
impl<T: PartitionFact> UnboundPartitionReport<T> {
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn counts(&self) -> PartitionCounts {
        match self { Self::Write { counts, .. } | Self::Noop { counts, .. } | Self::Refused { counts, .. } => *counts }
    }
    #[allow(dead_code)] // Optional read-only generated API.
    pub(crate) fn group(&self) -> Option<&PartitionGroup> {
        match self { Self::Write { group, .. } | Self::Noop { group, .. } | Self::Refused { group, .. } => group.as_ref() }
    }
}

/// All fallible observations happen inside one private trial. An error drops it.
pub(crate) fn fold_partition<T: PartitionFact>(baseline: Vec<T>, incoming: Vec<T>) -> Result<ClosedPartition<T>, PartitionError> {
    let group = checked_group(&baseline, &incoming)?;
    let mut owners = BTreeMap::new();
    // Baseline replay preserves the existing last-wins rule but emits no incoming
    // observation. Keep the exact original rows for Noop and whole-batch refusal.
    for row in &baseline {
        let mut owner = FactOwner::new();
        if owner.write(row.clone()).map_err(PartitionError::Row)? != WriteEffect::Insert { return Err(PartitionError::BrokenComposition); }
        owners.insert(row.partition_key(), owner);
    }
    let mut controller = control::${controlClass}::new();
    let mut counts = PartitionCounts { inserted: 0, unchanged: 0 };
    let mut conflicts = Vec::new();
    for row in incoming {
        let owner = owners.entry(row.partition_key()).or_insert_with(FactOwner::new);
        let event = match owner.write(row).map_err(PartitionError::Row)? {
            WriteEffect::Insert => {
                counts.inserted = counts.inserted.checked_add(1).ok_or(PartitionError::CountExhausted)?;
                control::Event::Insert
            },
            WriteEffect::Same => {
                counts.unchanged = counts.unchanged.checked_add(1).ok_or(PartitionError::CountExhausted)?;
                control::Event::Same
            },
            WriteEffect::Clash => {
                conflicts.push(PartitionConflict {
                    stored: owner.stored().ok_or(PartitionError::BrokenComposition)?.clone(),
                    rejected: owner.rejected().ok_or(PartitionError::BrokenComposition)?.clone(),
                });
                control::Event::Clash
            },
        };
        controller.send(event).map_err(PartitionError::Control)?;
    }
    let event = close_event(controller.read().node_id).ok_or(PartitionError::BrokenComposition)?;
    controller.send(event).map_err(PartitionError::Control)?;
    if matches!(consume_event(controller.read().node_id), Some((_, ReportKind::Refused))) { counts.inserted = 0; }
    Ok(ClosedPartition { controller, owners, original: baseline, conflicts, counts, group })
}
`;
  const rowFiles = generateRowRust({ ...plan.row, className: input.className, rustCrateMode: input.rustCrateMode, internalVisibility: 'private' });
  const manifest = rowFiles.find(file => file.path === 'Cargo.toml');
  const packageName = /^name = "([a-z0-9-]+)"$/m.exec(manifest?.content ?? '')?.[1];
  if (!packageName) throw new Error('PART301: generated primitive package name is absent');
  return rowFiles.map(file => {
    if (file.path === 'adapter.rs') return { ...file, content: file.content + adapterExtension };
    if (file.path === 'src/lib.rs') return { ...file, content: beforeGeneratedTests(file.content, `// Separate live finite controllers can never be injected into the private fold.\npub mod partition_control {\n${controlSource}\n}\n`) };
    if (file.path === 'README.md') return { ...file, content: `# Generated closed partition data fold

Import this primitive crate as \`sgd_fact_authority\` and include \`adapter.rs\` privately in the source-audited application. Call \`fold_partition(baseline, incoming)?.into_report()?\` using one of the sealed generated Fact types. The returned Write, Noop, or Refused report is ordinary unbound data, not a storage permission.

The primitive package is \`${packageName}\`. Add this application dependency, adjusting the relative path:

\`\`\`toml
[dependencies]
sgd_fact_authority = { package = "${packageName}", path = "../generated/rust" }
\`\`\`

Run \`cargo test --manifest-path /app/generated/rust/Cargo.toml\` for the primitive crate, then run the application's native checks. In workspace mode, include the generated crate in the application's workspace members. Keep the original private adapter include outside generated output and regenerate after changing application sources.

Metadata binds each Fact's one to three raw signed i64 key fields, exact symbol, and nonnegative i64 microsecond time. All supplied baseline and incoming rows must share one symbol and UTC day index. Keys use signed lexicographic ordering, independently of identity encoding. The private row owners dispatch exact Insert/Same/Clash observations to a private finite controller. Closing and consuming follow the actual validated graph. Counts use checked u64 arithmetic. Noop and Refused preserve the exact original baseline; Write materializes last-wins baseline rows in signed key order. Every Clash retains a complete pair, including repeated identical state stutters.

The fold binds neither a selected dataset/path nor a loaded baseline or writer. It does not establish persistence, effect atomicity, global source/sink coverage, cross-process isolation, or a collection theorem beyond the admitted model and native runtime checks. Keep the original source binding mandatory.\n` };
    return file;
  });
}
