const { readFileSync, writeFileSync } = require('node:fs');
const { Data, NtExecutable, NtExecutableResource, Resource } = require('resedit');

const [executablePath, iconPath] = process.argv.slice(2);
const executable = NtExecutable.from(readFileSync(executablePath), { ignoreCert: true });
const resources = NtExecutableResource.from(executable);
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
if (!groups.length) throw new Error('Could not find the Windows executable icon resource.');

const { icons } = Data.IconFile.from(readFileSync(iconPath));
for (const group of groups) {
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang,
    icons.map(item => item.data));
}
resources.outputResource(executable);
writeFileSync(executablePath, Buffer.from(executable.generate()));
