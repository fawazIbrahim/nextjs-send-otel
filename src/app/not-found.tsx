import Link from "next/link";

export default function NotFound() {
  return (
    <div className="state">
      <h1>Page not found</h1>
      <p>The product you are looking for does not exist or is no longer available.</p>
      <Link href="/">Back to products</Link>
    </div>
  );
}
