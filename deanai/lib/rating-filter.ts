// Database ratings use half-star units: 8 = 4 stars, 9 = 4.5 stars.
export const RATING_CHOICES = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "unrated"];
const LEGACY: Record<string, string> = { gte9: "10,9", gte8: "8", eq8: "8", gte6: "7,6", "6to7": "7,6", lte5: "5,4,3,2,1" };
export function normalizeRatingFilter(value: unknown): string {
  const raw = typeof value === "string" ? (LEGACY[value] ?? value).split(",") : [];
  return RATING_CHOICES.filter((rating) => raw.includes(rating)).join(",");
}
export function ratingLabel(value: string): string { return value === "unrated" ? "未评分" : Number(value) / 2 + "★"; }
export function ratingMatches(filter: string, rating: number | null): boolean {
  return !filter || normalizeRatingFilter(filter).split(",").includes(rating === null ? "unrated" : String(rating));
}
