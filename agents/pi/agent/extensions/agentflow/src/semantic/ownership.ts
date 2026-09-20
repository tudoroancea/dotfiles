export function ownershipOverlaps(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  return left.some((a) =>
    right.some((b) => {
      const x = normalize(a);
      const y = normalize(b);
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
    }),
  );
}
