use sgd_ingestion_example::pipeline::Document;
use sgd_ingestion_example::storage::Storage;

#[test]
fn validation_must_precede_storage() {
    let mut document = Document::new("accepted");
    let mut storage = Storage::default();
    assert!(document.persist(&mut storage).is_err());
    assert_eq!(document.state(), "Received");
    assert!(!storage.ids.contains(&document.id));
    document.validate().unwrap();
    assert_eq!(document.state(), "Validated");
    assert!(document.validate().is_err());
    assert_eq!(document.state(), "Validated");
    assert!(document.reject().is_err());
    assert_eq!(document.state(), "Validated");
    document.persist(&mut storage).unwrap();
    assert_eq!(document.state(), "Stored");
    assert!(storage.ids.contains(&document.id));
    for action in ["Validate", "Persist", "Reject"] {
        let result = match action {
            "Validate" => document.validate(),
            "Persist" => document.persist(&mut storage),
            _ => document.reject(),
        };
        assert!(result.is_err());
        assert_eq!(document.state(), "Stored");
        assert!(storage.ids.contains(&document.id));
    }
}

#[test]
fn rejection_is_terminal_and_does_not_store() {
    let mut document = Document::new("rejected");
    let mut storage = Storage::default();
    document.reject().unwrap();
    assert_eq!(document.state(), "Rejected");
    for action in ["Validate", "Persist", "Reject"] {
        let result = match action {
            "Validate" => document.validate(),
            "Persist" => document.persist(&mut storage),
            _ => document.reject(),
        };
        assert!(result.is_err());
        assert_eq!(document.state(), "Rejected");
        assert!(!storage.ids.contains(&document.id));
    }
}
