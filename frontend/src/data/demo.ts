/**
 * Dados de exemplo da prévia de relatórios do cliente (alcance, anúncios, melhores posts).
 * Substituir pelos endpoints de métricas quando Instagram/Meta Ads/Google estiverem conectados.
 */
export type PeriodoCliente = 'semana' | 'mes';
export const cliente = {
  nome: 'Padaria Bom Grão', bairro: 'Cambuí, Campinas', pendentes: 4,
  series: {
    semana: { nome: 'semana', labels: ['sex', 'sáb', 'dom', 'seg', 'ter', 'qua', 'qui'], max: 2.4,
              org: [1.0, 1.4, 1.3, 0.9, 1.0, 1.1, 1.3], pago: [0.7, 0.8, 0.7, 0.6, 0.7, 0.7, 0.8],
              kpi: [['13.000', '+7%'], ['108', '+11%'], ['26', '+8%'], ['R$ 3,52', '−4%']] },
    mes: { nome: 'mês', labels: ['6 out', '13 out', '20 out', '27 out'], max: 14,
           org: [6.1, 6.8, 7.4, 8.0], pago: [4.9, 5.0, 5.0, 5.0],
           kpi: [['48.200', '+18%'], ['412', '+22%'], ['96', '+15%'], ['R$ 3,64', '−9%']] },
  } as Record<PeriodoCliente, { nome: string; labels: string[]; max: number; org: number[]; pago: number[]; kpi: string[][] }>,
  whatsapp: { ia: 0.78, resposta: '38 s', foraHorario: '31%', qualidade: 'boa' },
  calor: [
    ['seg', [0.3, 0.6, 0.4, 0.5, 0.2, 0.3, 0.5, 0.2]], ['ter', [0.3, 0.5, 0.4, 0.5, 0.2, 0.3, 0.6, 0.2]],
    ['qua', [0.3, 0.6, 0.4, 0.6, 0.3, 0.3, 0.6, 0.3]], ['qui', [0.4, 0.6, 0.5, 0.6, 0.3, 0.4, 0.7, 0.3]],
    ['sex', [0.4, 0.7, 0.5, 0.7, 0.3, 0.5, 0.9, 0.5]], ['sáb', [0.6, 1.0, 0.8, 0.6, 0.3, 0.4, 0.6, 0.3]],
    ['dom', [0.5, 0.9, 0.7, 0.4, 0.1, 0.1, 0.1, 0.0]],
  ] as [string, number[]][],
  anuncios: { usado: 'R$ 1.140', verba: 'R$ 1.275', pct: 89, cliques: '318', cpc: 'R$ 0,82', encomendas: '41', retorno: '4,1×' },
  posts: [
    ['Bastidores: da massa ao balcão', 'TikTok · 1 nov · 312 salvamentos', 14800],
    ['4 jeitos de usar o pão de fermentação natural', 'Instagram · carrossel · 26 out', 9600],
    ['Pão de queijo saindo às 7h e às 15h', 'Google · 20 out · 87 rotas pedidas', 6100],
    ['Cheirinho de pão às 6h no Cambuí', 'Instagram · 14 out', 4300],
  ] as [string, string, number][],
};
