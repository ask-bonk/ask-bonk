-- Workflow success vs failure rate by repo (last 7 days)
-- Shows percentage breakdown of workflow outcomes per repository
SELECT
  index1 AS repo,
  blob3 AS status,
  COUNT() AS count,
  COUNT() * 100.0 / SUM(COUNT()) OVER (PARTITION BY index1) AS percentage
FROM BONK_EVENTS
WHERE blob1 = 'finalize'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY repo, status
ORDER BY repo, count DESC
