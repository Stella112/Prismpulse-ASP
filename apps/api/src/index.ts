import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4021);
const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`PrismPulse API listening on port ${port}`);
});

