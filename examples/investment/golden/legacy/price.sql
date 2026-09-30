-- Golden: price with vendor precedence and effective dating
CREATE VIEW price_master AS
SELECT
  security_id,
  vendor,
  close_price,
  price_date,
  is_adjusted
FROM raw_vendor_price
WHERE vendor_rank = 1;
