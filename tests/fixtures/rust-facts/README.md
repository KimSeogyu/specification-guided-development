# Public Parangsae Fact source fixture

The Fact definitions and core value implementations come from the user's public [Parangsae repository](https://github.com/KimSeogyu/parangsae), inspected on 2026-10-24. `rows-main.rs` preserves the inspected main-branch Fact source. The fixture application's `rows.rs` applies the exact Kline equality clause from [pending PR #5](https://github.com/KimSeogyu/parangsae/pull/5). It treats only source schemas 1 and 2 as equivalent and excludes received time from payload equality.

`fixed.rs`, `symbol.rs`, `time.rs`, and `timestamps.rs` retain the inspected public implementations. The fixture manifests and module entry points contain only the dependencies and exports needed to compile these real types in isolation. They are deliberately smaller than the application's workspace and are not evidence of full Parangsae source coverage or application adoption. No market data or private account material is included.
