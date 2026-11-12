/** The "+ Diagram" starters: minimal valid skeletons (2–3 elements) so the
 *  learner never starts from blank Mermaid syntax. Inserted as a ```mermaid
 *  fence with the caret at the end of the diagram-type line. */

export interface DiagramTemplate {
	id: string;
	label: string;
	source: string;
}

export const DIAGRAM_TEMPLATES: DiagramTemplate[] = [
	{
		id: "flowchart",
		label: "Flowchart",
		source: "flowchart LR\n  A[Client] --> B[Service]\n  B --> C[(Database)]",
	},
	{
		id: "sequence",
		label: "Sequence",
		source:
			"sequenceDiagram\n  participant C as Client\n  participant S as Server\n  C->>S: request\n  S-->>C: response",
	},
	{
		id: "class",
		label: "Class",
		source: "classDiagram\n  class Animal {\n    +name: string\n  }\n  class Dog\n  Animal <|-- Dog",
	},
	{
		id: "state",
		label: "State",
		source: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> [*]",
	},
	{
		id: "er",
		label: "ER",
		source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
	},
	{
		id: "c4-context",
		label: "C4 Context",
		source: 'C4Context\n  Person(user, "User")\n  System(sys, "System")\n  Rel(user, sys, "Uses")',
	},
	{
		id: "c4-container",
		label: "C4 Container",
		source:
			'C4Container\n  Person(user, "User")\n  System_Boundary(b, "System") {\n    Container(web, "Web App", "TypeScript")\n    ContainerDb(db, "Database", "Postgres")\n  }\n  Rel(user, web, "Uses")\n  Rel(web, db, "Reads/writes")',
	},
];

const OPENER = "```mermaid\n";

/** The fenced snippet plus where the caret lands inside it. */
export function fencedTemplate(template: DiagramTemplate): { snippet: string; cursor: number } {
	const firstLineEnd = template.source.indexOf("\n");
	return {
		snippet: `${OPENER}${template.source}\n\`\`\``,
		cursor: OPENER.length + (firstLineEnd === -1 ? template.source.length : firstLineEnd),
	};
}
