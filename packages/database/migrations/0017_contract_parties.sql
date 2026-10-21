-- Derive participation from immutable responsibility, including historical contracts.
-- Existing resource and delivery grants are deliberately preserved.
CREATE VIEW contract_parties AS
 SELECT id AS contract_id, buyer_id AS user_id, 'buyer' AS role FROM contracts
 UNION ALL
 SELECT id AS contract_id, seller_id AS user_id, 'seller' AS role FROM contracts;
