import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import * as cartService from '../src/services/cart.service';

jest.mock('../src/services/cart.service');
const mockedService = cartService as jest.Mocked<typeof cartService>;

const SECRET = 'test_secret';
let token: string;

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  token = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'CUSTOMER' }, SECRET);
});

beforeEach(() => jest.clearAllMocks());


describe('cart routes', () => {
  it('401 sem token', async () => {
    const res = await request(app).get('/cart');
    expect(res.status).toBe(401);
  });

  it('GET /cart retorna itens', async () => {
    mockedService.getCart.mockResolvedValue([{ productId: 'p1', quantity: 2 }]);
    const res = await request(app)
      .get('/cart')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ productId: 'p1', quantity: 2 }] });
    expect(mockedService.getCart).toHaveBeenCalledWith('u1');
  });

  it('POST /cart/items 400 com quantity invalida', async () => {
    const res = await request(app)
      .post('/cart/items')
      .set('Authorization', 'Bearer ' + token)
      .send({ productId: 'p1', quantity: 0 });
    expect(res.status).toBe(400);
    expect(mockedService.addItem).not.toHaveBeenCalled();
  });

  it('POST /cart/items 200 adiciona', async () => {
    mockedService.addItem.mockResolvedValue([{ productId: 'p1', quantity: 3 }]);
    const res = await request(app)
      .post('/cart/items')
      .set('Authorization', 'Bearer ' + token)
      .send({ productId: 'p1', quantity: 3 });
    expect(res.status).toBe(200);
    expect(mockedService.addItem).toHaveBeenCalledWith('u1', 'p1', 3);
  });

  it('PATCH /cart/items/:id 404 quando item nao existe', async () => {
    mockedService.updateQuantity.mockRejectedValue(
      new Error('ITEM_NAO_ENCONTRADO')
    );
    const res = await request(app)
      .patch('/cart/items/p9')
      .set('Authorization', 'Bearer ' + token)
      .send({ quantity: 5 });
    expect(res.status).toBe(404);
  });

  it('DELETE /cart/items/:id remove', async () => {
    mockedService.removeItem.mockResolvedValue([]);
    const res = await request(app)
      .delete('/cart/items/p1')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(mockedService.removeItem).toHaveBeenCalledWith('u1', 'p1');
  });

  it('DELETE /cart esvazia (204)', async () => {
    mockedService.clearCart.mockResolvedValue(undefined);
    const res = await request(app)
      .delete('/cart')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(204);
    expect(mockedService.clearCart).toHaveBeenCalledWith('u1');
  });
});
