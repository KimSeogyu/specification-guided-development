fn main() {
    let _ = authority::finalize(vec![1], |payload| {
        let _moved = *payload;
        Ok::<(), ()>(())
    });
}
