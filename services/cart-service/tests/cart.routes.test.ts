import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import * as cartService from '../src/services/cart.service';

jest.mock('../src/services/cart.service');
const mockedService = cartService as jest.Mocked<typeof cartService>;

const SECRET = 'test_secret';
const OLD_SECRET = process.env.JWT_SECRET;
let token: string;

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  token = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'CUSTOMER' }, SECRET);
});

afterAll(() => {
  process.env.JWT_SECRET = OLD_SECRET;
});

beforeEach(() => jest.clearAllMocks());

const authH = () => ({ Authorization: 'Bearer ' + token });

describe('cart routes', () => {
  it('401 sem token', async () => {
    const res = await request(app).get('/cart');
    expect(res.status).toBe(401);
  });

  it('GET /cart retorna carrinho enriquecido', async () => {
    mockedService.getCartDetailed.mockResolvedValue({
      items: [
        {
          productId: 'p1',
          quantity: 2,
          name: 'Camisa',
          price: 10,
          subtotal: 20,
          available: 5,
        },
      ],
      total: 20,
      partial: false,
    });
    const res = await request(app).get('/cart').set(authH());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(20);
    expect(res.body.items[0]).toMatchObject({ productId: 'p1', name: 'Camisa', subtotal: 20 });
    expect(mockedService.getCartDetailed).toHaveBeenCalledWith('u1');
  });

  it('GET /cart -> 500 JSON quando o servico falha', async () => {
    mockedService.getCartDetailed.mockRejectedValue(new Error('redis down'));
    const res = await request(app).get('/cart').set(authH());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Erro interno' });
  });

  it('POST /cart/items 400 com quantity zero', async () => {
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 0 });
    expect(res.status).toBe(400);
    expect(mockedService.addItem).not.toHaveBeenCalled();
  });

  it('POST /cart/items 200 no limite (quantity 10000)', async () => {
    mockedService.addItem.mockResolvedValue([{ productId: 'p1', quantity: 10000 }]);
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 10000 });
    expect(res.status).toBe(200);
  });

  it('POST /cart/items 400 acima do limite (quantity 10001)', async () => {
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 10001 });
    expect(res.status).toBe(400);
    expect(mockedService.addItem).not.toHaveBeenCalled();
  });

  it('POST /cart/items 400 com productId vazio', async () => {
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: '   ', quantity: 2 });
    expect(res.status).toBe(400);
    expect(mockedService.addItem).not.toHaveBeenCalled();
  });

  it('POST /cart/items 400 com productId acima de 128 chars', async () => {
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p'.repeat(129), quantity: 1 });
    expect(res.status).toBe(400);
    expect(mockedService.addItem).not.toHaveBeenCalled();
  });

  it('POST /cart/items 200 adiciona (productId normalizado)', async () => {
    mockedService.addItem.mockResolvedValue([{ productId: 'p1', quantity: 3 }]);
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: '  p1  ', quantity: 3 });
    expect(res.status).toBe(200);
    expect(mockedService.addItem).toHaveBeenCalledWith('u1', 'p1', 3);
  });

  it('PATCH /cart/items/:id 200 atualiza', async () => {
    mockedService.updateQuantity.mockResolvedValue([
      { productId: 'p1', quantity: 7 },
    ]);
    const res = await request(app)
      .patch('/cart/items/p1')
      .set(authH())
      .send({ quantity: 7 });
    expect(res.status).toBe(200);
    expect(mockedService.updateQuantity).toHaveBeenCalledWith('u1', 'p1', 7);
  });

  it('PATCH /cart/items/:id 400 com quantity invalida', async () => {
    const res = await request(app)
      .patch('/cart/items/p1')
      .set(authH())
      .send({ quantity: -1 });
    expect(res.status).toBe(400);
    expect(mockedService.updateQuantity).not.toHaveBeenCalled();
  });

  it('PATCH /cart/items/:id 404 quando item nao existe', async () => {
    mockedService.updateQuantity.mockRejectedValue(
      new Error('ITEM_NAO_ENCONTRADO')
    );
    const res = await request(app)
      .patch('/cart/items/p9')
      .set(authH())
      .send({ quantity: 5 });
    expect(res.status).toBe(404);
  });

  it('DELETE /cart/items/:id remove', async () => {
    mockedService.removeItem.mockResolvedValue([]);
    const res = await request(app).delete('/cart/items/p1').set(authH());
    expect(res.status).toBe(200);
    expect(mockedService.removeItem).toHaveBeenCalledWith('u1', 'p1');
  });

  it('POST /cart/items 404 quando o produto nao existe', async () => {
    mockedService.addItem.mockRejectedValue(new Error('PRODUTO_NAO_ENCONTRADO'));
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('POST /cart/items 409 quando o estoque e insuficiente', async () => {
    mockedService.addItem.mockRejectedValue(new Error('ESTOQUE_INSUFICIENTE'));
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 1 });
    expect(res.status).toBe(409);
  });

  it('POST /cart/items 503 quando o product-service esta fora', async () => {
    mockedService.addItem.mockRejectedValue(
      new Error('PRODUTO_SERVICE_INDISPONIVEL')
    );
    const res = await request(app)
      .post('/cart/items')
      .set(authH())
      .send({ productId: 'p1', quantity: 1 });
    expect(res.status).toBe(503);
  });

  it('PATCH /cart/items/:id 404 quando o produto nao existe', async () => {
    mockedService.updateQuantity.mockRejectedValue(new Error('PRODUTO_NAO_ENCONTRADO'));
    const res = await request(app).patch('/cart/items/p1').set(authH()).send({ quantity: 2 });
    expect(res.status).toBe(404);
  });

  it('PATCH /cart/items/:id 409 quando o estoque e insuficiente', async () => {
    mockedService.updateQuantity.mockRejectedValue(new Error('ESTOQUE_INSUFICIENTE'));
    const res = await request(app).patch('/cart/items/p1').set(authH()).send({ quantity: 2 });
    expect(res.status).toBe(409);
  });

  it('PATCH /cart/items/:id 503 quando o product-service esta fora', async () => {
    mockedService.updateQuantity.mockRejectedValue(new Error('PRODUTO_SERVICE_INDISPONIVEL'));
    const res = await request(app).patch('/cart/items/p1').set(authH()).send({ quantity: 2 });
    expect(res.status).toBe(503);
  });

  it('DELETE /cart esvazia (204)', async () => {
    mockedService.clearCart.mockResolvedValue(undefined);
    const res = await request(app).delete('/cart').set(authH());
    expect(res.status).toBe(204);
    expect(mockedService.clearCart).toHaveBeenCalledWith('u1');
  });
});
