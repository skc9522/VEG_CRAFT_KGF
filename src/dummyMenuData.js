/**
 * Sample dishes when VITE_USE_DUMMY_MENU=true — same fields as Firestore `menus`.
 */
export const DUMMY_MENU_ITEMS = [
  { id: 'd1', category: 'FRESH JUICE', name: 'Lime juice', price: 30, priceLarge: null, description: '', available: true },
  { id: 'd2', category: 'FRESH JUICE', name: 'Orange juice', price: 50, priceLarge: null, description: '', available: true },
  { id: 'd3', category: 'Mocktail', name: 'Virgin mojito', price: 60, priceLarge: null, description: '', available: true },
  { id: 'd4', category: 'STARTERS', name: 'Gobi Manchurian', price: 70, priceLarge: null, description: '', available: true },
  { id: 'd5', category: 'BURGERS', name: 'American veg burger', price: 100, priceLarge: null, description: '', available: true },
  {
    id: 'd6',
    category: 'PIZZAS',
    name: 'Pizza margarita',
    price: 140,
    priceLarge: 230,
    description: 'Lot of cheese',
    available: true,
  },
  { id: 'd7', category: 'PIZZAS', name: 'extra cheese', price: 40, priceLarge: null, description: 'Add-on', available: true },
  { id: 'd8', name: 'Chef special (sold out)', price: 120, priceLarge: null, description: '', available: false },
];
