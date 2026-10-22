// Parse inline JavaScript as well as HTML; the HTML linter does not check JS syntax.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const file of ['teacher.html', 'student.html', 'answers.html']) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', file), 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new vm.Script(match[1], { filename: file });
  }
}
console.log('Inline JavaScript syntax OK');
