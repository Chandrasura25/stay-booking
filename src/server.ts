import { listen } from "./app.js";

const port = Number(process.env.PORT || 3000);
await listen(port);
console.log(`stay-booking demo on http://localhost:${port}`);
