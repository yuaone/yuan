import { divide, add, multiply } from './calculator';

const result1 = add(10, 5);
console.log('10 + 5 =', result1);

const result2 = multiply(3, 4);
console.log('3 * 4 =', result2);

// BUG: this will produce Infinity or NaN
const result3 = divide(10, 0);
console.log('10 / 0 =', result3);
