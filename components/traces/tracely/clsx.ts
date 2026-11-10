// The subset of `clsx` the vendored Tracely components use: class strings, skipping falsy parts.
export default function clsx(...parts: unknown[]): string {
  return parts.filter((p) => typeof p === "string" && p).join(" ");
}
