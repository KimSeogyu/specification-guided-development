fn main() {
    let _ = authority::finalize(vec![1], |payload| {
        payload.clear();
        Ok::<(), ()>(())
    });
}
