use policy_declarations::transition;
fn main() { let action = "Validate"; transition("Received", action, "Validated"); }
