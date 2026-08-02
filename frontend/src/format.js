// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" UTC text (see
// migrations/schema.sql) - Safari/some engines won't parse that form
// directly with `new Date(...)`, so normalize to ISO 8601 first.
export function formatDateTime(sqliteTimestamp) {
  if (!sqliteTimestamp) return '-';
  const iso = sqliteTimestamp.includes('T') ? sqliteTimestamp : `${sqliteTimestamp.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return sqliteTimestamp;
  return date.toLocaleString();
}
