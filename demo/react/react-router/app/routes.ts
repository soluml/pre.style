import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('cn', 'routes/cn.tsx'),
  route('interpolation', 'routes/interpolation.tsx'),
  route('server', 'routes/server.tsx'),
] satisfies RouteConfig;
