// Minimal typing for the optional peer `next`; the real module is resolved by the app's bundler.
declare module "next/headers" {
  export function headers(): unknown;
}
