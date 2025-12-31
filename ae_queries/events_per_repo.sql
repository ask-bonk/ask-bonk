-- Events per repo (last 7 days)
-- Groups by repo and event type to show activity distribution
SELECT
  index1 AS repo,
  blob1 AS event_type,
  COUNT() AS event_count
FROM bonk_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY repo, event_type
ORDER BY event_count DESC
LIMIT 100
