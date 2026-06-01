import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.AUTH_PORT || 3001;

app.use(helmet());
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Auth service rodando na porta ${PORT}`);
});

export default app;
