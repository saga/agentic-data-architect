-- Golden: IBOR position (authoritative candidate, as-of dated)
CREATE VIEW portfolio_position AS
WITH p AS (
  SELECT security_id, position_qty, as_of_date, status
  FROM ibor_position
  WHERE status IN ('SETTLED', 'TRADED')
)
SELECT
  p.security_id,
  p.position_qty,
  p.as_of_date,
  p.position_qty * s.close_price AS market_value
FROM p
JOIN security_price s ON s.security_id = p.security_id;
