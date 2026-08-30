# SEC Filing Explorer

## Goal
Let a user type a ticker and fetch recent SEC filings.

## Actions
- `search_filings`
  - Input: `{ ticker: string }`
  - Output: `{ ticker: string, filings: Array<{ form: string, filedAt: string, accession: string }> }`

## UI Requirements
- Text input for ticker symbol
- Button to execute action `search_filings`
- Result list for returned filings
- Clear error and loading states
