import { app } from './app.js';

const PORT = process.env.PORT || 3000;

export const server = app.listen(PORT, () => {
  console.log(`⚡ ClaimFlow Server listening on http://localhost:${PORT}`);
});
