const { createLocaleParityReport, STAGED_REQUIRED_PREFIXES } = require('./locale-parity.cjs');

const strict = process.argv.includes('--strict');
const report = createLocaleParityReport();

const byLocale = new Map();
for (const issue of report.issues) {
  const bucket = byLocale.get(issue.locale) ?? { errors: [], warnings: [] };
  bucket[issue.severity === 'error' ? 'errors' : 'warnings'].push(issue);
  byLocale.set(issue.locale, bucket);
}

if (report.issues.length === 0) {
  console.log('Locale parity is clean.');
  process.exit(0);
}

console.log(`Canonical locale: ${report.canonicalLocale}`);
console.log(`Required prefixes: ${STAGED_REQUIRED_PREFIXES.join(', ')}`);

for (const locale of report.locales) {
  if (locale === report.canonicalLocale) {
    continue;
  }

  const bucket = byLocale.get(locale) ?? { errors: [], warnings: [] };
  console.log(
    `${locale}: ${bucket.errors.length} error(s), ${bucket.warnings.length} warning(s)`,
  );

  for (const issue of bucket.errors.slice(0, 20)) {
    console.log(`  ERROR ${issue.type} ${issue.key}`);
  }

  if (bucket.errors.length > 20) {
    console.log(`  ... ${bucket.errors.length - 20} more errors`);
  }

  for (const issue of bucket.warnings.slice(0, 10)) {
    console.log(`  WARN ${issue.type} ${issue.key}`);
  }

  if (bucket.warnings.length > 10) {
    console.log(`  ... ${bucket.warnings.length - 10} more warnings`);
  }
}

if (strict && report.issues.length > 0) {
  process.exit(1);
}
