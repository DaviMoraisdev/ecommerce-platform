import { requireRole } from '../src/middlewares/role.middleware';
import { Request, Response, NextFunction } from 'express';

describe('requireRole middleware', () => {
  function mockReqRes(userRole?: string) {
    const req = { userRole } as any;
    const statusMock = jest.fn().mockReturnThis();
    const jsonMock = jest.fn();
    const res = { status: statusMock, json: jsonMock } as any as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next, statusMock, jsonMock };
  }

  it('deve permitir acesso quando o papel e correto', () => {
    const { req, res, next } = mockReqRes('ADMIN');
    const middleware = requireRole('ADMIN');
    middleware(req as Request, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('deve bloquear com 403 quando o papel e insuficiente', () => {
    const { req, res, next, statusMock } = mockReqRes('BUYER');
    const middleware = requireRole('ADMIN');
    middleware(req as Request, res, next);
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('deve bloquear com 401 quando nao ha papel', () => {
    const { req, res, next, statusMock } = mockReqRes(undefined);
    const middleware = requireRole('ADMIN');
    middleware(req as Request, res, next);
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
