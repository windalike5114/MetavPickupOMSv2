# Pickup System API Documentation

This API pushes SKU names, inventory fields, and warehouse locations into the Pickup System.

## Base URL

`https://acapickup.com`

## Authentication

Send the API key as a Bearer token.

```http
Authorization: Bearer ecpp_sk_8f2a9b4c7d1e6f3a5b0c9d8e7f6a5b4c
Content-Type: application/json
```

## Push SKU data

- **Endpoint:** `/api/ecpp/push`
- **Method:** `POST`
- **Content-Type:** `application/json`
- **Body:** one SKU object or an array of SKU objects
- **Write behavior:** upsert; unchanged records are skipped

### Fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `sku` | String | Yes | Product SKU and unique identifier. `SKU` is also accepted. |
| `productName` | String | No | Product name. `productname`, `product_name`, and `name` are also accepted. |
| `location` | String or Object | No | Legacy AKL location string, or an `{ "AKL": "...", "CHC": "..." }` warehouse map. |
| `warehouseId` | String | No | Warehouse for a scalar `location`; accepted values are `AKL` and `CHC`. |
| `locations` | Object | No | Warehouse map such as `{ "AKL": "A-01", "CHC": "C-02" }`. |
| `availableQty` | Number | No | Available quantity. Common snake-case aliases are accepted. |
| `stockQty` | Number | No | Stock quantity. Common snake-case aliases are accepted. |
| `onHandQty` | Number | No | On-hand quantity. Common snake-case aliases are accepted. |
| `allocatedQty` | Number | No | Allocated quantity. Common snake-case aliases are accepted. |
| `inventoryQty` | Number | No | Inventory quantity. Common snake-case aliases are accepted. |

Location strings are trimmed and converted to uppercase. Structured values are never converted to strings, preventing invalid values such as `[OBJECT OBJECT]`.

### Request examples

Legacy AKL format:

```json
{
  "sku": "SKU-001",
  "productName": "Premium Wireless Mouse",
  "location": "b-05-c"
}
```

One warehouse per record:

```json
{
  "sku": "SKU-001",
  "warehouseId": "CHC",
  "location": "c-10-a"
}
```

Multiple warehouses in one record (preferred):

```json
{
  "sku": "SKU-001",
  "locations": {
    "AKL": "A-01",
    "CHC": "C-10-A"
  }
}
```

For compatibility, the same map is also accepted under `location`:

```json
{
  "sku": "SKU-001",
  "location": {
    "AKL": "A-01",
    "CHC": "C-10-A"
  }
}
```

Batch request:

```json
[
  { "sku": "SKU-001", "warehouseId": "AKL", "location": "A-01" },
  { "sku": "SKU-002", "locations": { "AKL": "B-02", "CHC": "C-03" } }
]
```

## Response

Successful requests return processing counters:

```json
{
  "success": true,
  "message": "Processed. Skipped 1 unchanged items to save database quotas.",
  "details": {
    "received": 2,
    "memoryDuplicates": 0,
    "unmodifiedSkipped": 1,
    "actuallyProcessed": 1,
    "errors": []
  }
}
```

An item without an SKU is reported in `details.errors` and is not written. Authentication and server errors use an HTTP error status:

```json
{
  "success": false,
  "error": "Unauthorized: API Key mismatch."
}
```

## cURL example

```bash
curl --request POST "https://acapickup.com/api/ecpp/push" \
  --header "Authorization: Bearer ecpp_sk_8f2a9b4c7d1e6f3a5b0c9d8e7f6a5b4c" \
  --header "Content-Type: application/json" \
  --data '{"sku":"SKU-001","locations":{"AKL":"A-01","CHC":"C-10-A"}}'
```
