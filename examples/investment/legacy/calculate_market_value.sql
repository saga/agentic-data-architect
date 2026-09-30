-- IBOR position snapshot (authoritative candidate)
CREATE VIEW portfolio_position AS
SELECT
  p.security_id,
  p.position_qty,
  p.position_qty * s.close_price AS market_value
FROM ibor_position p
JOIN security_price s ON s.security_id = p.security_id;
