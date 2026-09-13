// Assemble the authoritative FLAGS array in CLI emission order.
// Domain arrays are package internals; consumers read FLAGS, never a subset.
const FLAGS = [
	...FLAG_DEFINITIONS_MODEL_CONTEXT,
	...FLAG_DEFINITIONS_HARDWARE,
	...FLAG_DEFINITIONS_SAMPLING,
	...FLAG_DEFINITIONS_CONVERSATION,
	...FLAG_DEFINITIONS_SPECULATIVE,
	...FLAG_DEFINITIONS_SERVER,
];
