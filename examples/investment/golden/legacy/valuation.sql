-- Golden: NAV aggregation (no time column on output -> temporal_risk expected)
CREATE VIEW portfolio_nav AS
SELECT
  portfolio_id,
  SUM(market_value) AS nav_value
FROM portfolio_position
GROUP BY portfolio_id;
