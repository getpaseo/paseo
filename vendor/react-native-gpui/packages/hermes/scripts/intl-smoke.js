// Run with the `hermes` CLI. The same assertions run on every platform: they
// check the Intl backend that reads the system's ICU, whichever ICU that is.
// With no usable system ICU the script checks the fallback instead and prints
// "MODE none"; otherwise it prints "MODE icu". The caller says which it expects.

var failures = [];
function check(name, actual, expected) {
  if (typeof actual === 'function') {
    try {
      actual = actual();
    } catch (error) {
      actual = 'threw ' + error;
    }
  }
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures.push(name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  }
}

var noIcu = new Intl.NumberFormat('en-US').format(1234.5) === '1234.5';
print('MODE ' + (noIcu ? 'none' : 'icu'));

if (noIcu) {
  // Without a system ICU Intl exists, numbers print plainly and nothing throws.
  check('plain number', function () { return new Intl.NumberFormat('en-US').format(1234.5); }, '1234.5');
  check('compare', function () { return new Intl.Collator().compare('a', 'b') < 0; }, true);
  check('date', function () { return typeof new Intl.DateTimeFormat().format(0); }, 'string');
  check('upper', function () { return 'abc'.toLocaleUpperCase(); }, 'ABC');
} else {
  // NumberFormat: grouping, currency, percent, compact, sign, unit.
  check('decimal', function () { return new Intl.NumberFormat('en-US').format(1234.5); }, '1,234.5');
  check('decimal de', function () { return new Intl.NumberFormat('de-DE').format(1234.5); }, '1.234,5');
  check(
    'currency usd',
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(1234.5),
    '$1,234.50',
  );
  check(
    'currency eur de',
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5),
    '1.234,50 €',
  );
  check(
    'currency jpy digits',
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'JPY' }).format(1234.5),
    '¥1,235',
  );
  check('percent', function () { return new Intl.NumberFormat('en-US', { style: 'percent' }).format(0.256); }, '26%');
  check(
    'fraction digits',
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(3),
    '3.00',
  );
  check(
    'significant digits',
    new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(123456),
    '123,000',
  );
  check('no grouping', function () { return new Intl.NumberFormat('en-US', { useGrouping: false }).format(12345); }, '12345');
  check(
    'compact',
    new Intl.NumberFormat('en-US', { notation: 'compact' }).format(1234),
    '1.2K',
  );
  check(
    'compact long',
    new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'long' }).format(1234567),
    '1.2 million',
  );
  check(
    'sign always',
    new Intl.NumberFormat('en-US', { signDisplay: 'always' }).format(5),
    '+5',
  );
  check(
    'unit',
    new Intl.NumberFormat('en-US', { style: 'unit', unit: 'kilometer-per-hour' }).format(16),
    '16 km/h',
  );
  check(
    'unit long',
    new Intl.NumberFormat('en-US', { style: 'unit', unit: 'liter', unitDisplay: 'long' }).format(2),
    '2 liters',
  );
  check(
    'min integer digits',
    new Intl.NumberFormat('en-US', { minimumIntegerDigits: 3 }).format(7),
    '007',
  );
  check('nan', function () { return new Intl.NumberFormat('en-US').format(NaN); }, 'NaN');
  check('infinity', function () { return new Intl.NumberFormat('en-US').format(Infinity); }, '∞');
  check('negative', function () { return new Intl.NumberFormat('en-US').format(-1234.5); }, '-1,234.5');

  var parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .formatToParts(-1234.5)
    .map(function (part) { return part.type + ':' + part.value; });
  check('formatToParts currency', function () { return parts; }, [
    'minusSign:-', 'currency:$', 'integer:1', 'group:,', 'integer:234', 'decimal:.', 'fraction:50',
  ]);
  check(
    'formatToParts percent',
    new Intl.NumberFormat('en-US', { style: 'percent' }).formatToParts(0.5).map(function (p) { return p.type; }),
    ['integer', 'percentSign'],
  );

  var resolved = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).resolvedOptions();
  check('resolved locale', function () { return resolved.locale; }, 'en-US');
  check('resolved style', function () { return resolved.style; }, 'currency');
  check('resolved currency', function () { return resolved.currency; }, 'EUR');
  check('resolved fraction', function () { return [resolved.minimumFractionDigits, resolved.maximumFractionDigits]; }, [2, 2]);
  check('supportedLocalesOf', function () { return Intl.NumberFormat.supportedLocalesOf(['en-US']); }, ['en-US']);

  // Number.prototype.toLocaleString with and without options.
  check('toLocaleString', function () { return (1234.5).toLocaleString('en-US'); }, '1,234.5');
  check(
    'toLocaleString options',
    (0.256).toLocaleString('en-US', { style: 'percent', minimumFractionDigits: 1 }),
    '25.6%',
  );
  check(
    'toLocaleString currency',
    (99.9).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
    '$99.90',
  );

  // DateTimeFormat, in UTC so the result does not depend on the machine.
  var when = Date.UTC(2024, 0, 15, 13, 45, 30);
  check(
    'date long',
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'long' }).format(when),
    'January 15, 2024',
  );
  check(
    'date numeric de',
    new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when),
    '15.01.2024',
  );
  check(
    'time h23',
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when),
    '13:45',
  );
  var dateParts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
    .formatToParts(when)
    .map(function (part) { return part.type + ':' + part.value; });
  check('date formatToParts', function () { return dateParts; }, [
    'month:January', 'literal: ', 'day:15', 'literal:, ', 'year:2024',
  ]);
  check(
    'resolved timeZone',
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' }).resolvedOptions().timeZone,
    'America/New_York',
  );
  check('toLocaleDateString', function () { return new Date(when).toLocaleDateString('en-US', { timeZone: 'UTC' }); }, '1/15/2024');
  // ICU 72 and later put a narrow no-break space before the day period.
  check('toLocaleTimeString', function () { return new Date(when).toLocaleTimeString('en-US', { timeZone: 'UTC' }).replace('\u202f', ' '); }, '1:45:30 PM');

  // Collator.
  check('collator sv', function () { return ['z', 'a', 'ä'].sort(new Intl.Collator('sv').compare); }, ['a', 'z', 'ä']);
  check('collator en', function () { return ['z', 'a', 'ä'].sort(new Intl.Collator('en').compare); }, ['a', 'ä', 'z']);
  check('collator numeric', function () { return ['a10', 'a2'].sort(new Intl.Collator('en', { numeric: true }).compare); }, ['a2', 'a10']);
  check('localeCompare', function () { return 'a'.localeCompare('b') < 0; }, true);

  // Case mapping that depends on the locale.
  check('upper tr', function () { return 'i'.toLocaleUpperCase('tr'); }, 'İ');
  check('lower tr', function () { return 'I'.toLocaleLowerCase('tr'); }, 'ı');
  check('upper en', function () { return 'straße'.toLocaleUpperCase('en'); }, 'STRASSE');

  check('getCanonicalLocales', function () { return Intl.getCanonicalLocales('EN-us'); }, ['en-US']);
}

if (failures.length) {
  print('FAIL (' + failures.length + ')');
  failures.forEach(function (failure) { print('  ' + failure); });
} else {
  print('PASS');
}
