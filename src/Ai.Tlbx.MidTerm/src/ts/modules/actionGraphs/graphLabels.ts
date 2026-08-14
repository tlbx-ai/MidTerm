export interface GraphLabelSource {
  id: string;
  name: string;
}

export function disambiguateGraphLabels(
  graphs: readonly GraphLabelSource[],
): Array<GraphLabelSource & { label: string }> {
  const nameCounts = new Map<string, number>();
  for (const graph of graphs) {
    const key = graph.name.trim().toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return graphs.map((graph) => {
    const key = graph.name.trim().toLocaleLowerCase();
    return {
      ...graph,
      label: (nameCounts.get(key) ?? 0) > 1 ? `${graph.name} (${graph.id})` : graph.name,
    };
  });
}
