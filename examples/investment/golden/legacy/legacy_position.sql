-- Golden: legacy position path (duplicate market_value logic, different identifier)
CREATE VIEW legacy_portfolio_value AS
SELECT
  l.sec_id AS security_id,
  l.pos_qty AS position_qty,
  l.pos_qty * px.px_adj AS mv_amt
FROM legacy_position l
JOIN legacy_price px ON px.sec_id = l.sec_id;
