export default function Loading() {
  return (
    <ul className="grid" aria-busy="true" aria-label="Loading products" style={{ marginTop: "2rem" }}>
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="skeleton" />
      ))}
    </ul>
  );
}
