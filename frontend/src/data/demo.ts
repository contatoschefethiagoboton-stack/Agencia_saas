/**
 * Dados de demonstração. Em produção, o Painel Master lê GET /api/admin/dashboard
 * e o painel do cliente lê os endpoints de métricas do tenant; o formato abaixo é o contrato.
 */
export type Periodo = '7d' | '30d' | '12m';

export const master = {
  series: {
    '7d': { title: 'Últimos 7 dias', labels: ['sex', 'sáb', 'dom', 'seg', 'ter', 'qua', 'qui'], max: 1.4,
            rev: [0.82, 1.01, 0.55, 0.48, 1.12, 1.06, 1.24], prof: [0.37, 0.47, 0.24, 0.2, 0.53, 0.5, 0.59],
            cli: [23, 23, 23, 24, 24, 24, 24],
            kpi: [['R$ 6.280', '+6,1%'], ['R$ 2.900', '+7,4%'], ['24', '+1'], ['R$ 8.900', '+3,2%']] },
    '30d': { title: 'Últimos 30 dias', labels: ['6 out', '13 out', '20 out', '27 out'], max: 8,
             rev: [5.2, 5.6, 5.9, 6.4], prof: [2.5, 2.7, 2.9, 3.1], cli: [21, 22, 23, 24],
             kpi: [['R$ 23.100', '+10,8%'], ['R$ 11.200', '+12,2%'], ['24', '+3'], ['R$ 37.400', '+9,1%']] },
    '12m': { title: 'Últimos 12 meses', labels: ['nov', 'dez', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out'], max: 25,
             rev: [6.2, 7.1, 8.0, 9.4, 10.8, 12.1, 13.9, 15.2, 17.0, 18.6, 20.9, 23.4],
             prof: [2.1, 2.6, 3.1, 3.8, 4.5, 5.2, 6.1, 6.8, 7.7, 8.6, 9.8, 11.2],
             cli: [5, 6, 8, 9, 11, 12, 14, 16, 18, 19, 21, 24],
             kpi: [['R$ 162.600', '+148%'], ['R$ 71.500', '+163%'], ['24', '+19'], ['R$ 298.000', '+131%']] },
  } as Record<Periodo, { title: string; labels: string[]; max: number; rev: number[]; prof: number[]; cli: number[]; kpi: string[][] }>,
  receita: [
    { label: 'Assinaturas', pct: 0.62, color: 'var(--accent)' },
    { label: 'Taxa de gestão de mídia', pct: 0.24, color: 'var(--orange)' },
    { label: 'Serviços avulsos', pct: 0.09, color: 'var(--teal)' },
    { label: 'Setup de novos clientes', pct: 0.05, color: 'var(--lilac)' },
  ],
  receitaMes: 'R$ 23,4 mil',
  carteira: { saldo: 'R$ 18.420,50', saques: [['15 out', 'R$ 9.000,00'], ['30 set', 'R$ 7.500,00']] },
  fundo: { saldo: 'R$ 3.640', investido: 'R$ 2.100', planejado: 'R$ 3.000', pct: 70, custoCliente: 'R$ 233' },
  funil: [['Visitantes do site', '3.940', 100], ['Cadastros', '486', 42], ['Testes grátis', '74', 18], ['Clientes pagantes', '9', 7]] as [string, string, number][],
  clientes: [
    { nome: 'Chef em Casa Campinas', plano: 'Pro', assinatura: 'R$ 797', midia: 'R$ 4.500', lucro: 'R$ 1.382', wa: 'Boa', tend: [3, 4, 4, 6, 7, 9] },
    { nome: 'Clínica Sorriso Vivo', plano: 'Pro', assinatura: 'R$ 797', midia: 'R$ 6.000', lucro: 'R$ 1.640', wa: 'Crítica', tend: [5, 6, 8, 8, 9, 8] },
    { nome: 'Barbearia Navalha', plano: 'Pro', assinatura: 'R$ 797', midia: 'R$ 3.200', lucro: 'R$ 1.150', wa: 'Boa', tend: [2, 3, 5, 5, 6, 7] },
    { nome: 'Studio Unhas da Lu', plano: 'Essencial', assinatura: 'R$ 497', midia: 'R$ 600', lucro: 'R$ 808', wa: 'Atenção', tend: [4, 4, 5, 4, 6, 6] },
    { nome: 'Padaria Bom Grão', plano: 'Essencial', assinatura: 'R$ 597', midia: 'R$ 1.500', lucro: 'R$ 732', wa: 'Boa', tend: [1, 2, 3, 3, 4, 5] },
    { nome: 'Pet Shop Patinhas', plano: 'Essencial', assinatura: 'R$ 497', midia: 'R$ 800', lucro: 'R$ 601', wa: 'Boa', tend: [3, 3, 4, 4, 4, 5] },
  ],
  usoIA: [['Clínica Sorriso Vivo', 91], ['Chef em Casa Campinas', 82], ['Padaria Bom Grão', 64], ['Barbearia Navalha', 58], ['Studio Unhas da Lu', 41], ['Pet Shop Patinhas', 37]] as [string, number][],
  alertas: [
    { nivel: 'Crítico', cliente: 'Clínica Sorriso Vivo', texto: 'Qualidade do WhatsApp caiu para vermelha. Envios ativos pausados; respostas a clientes continuam.' },
    { nivel: 'Atenção', cliente: 'Studio Unhas da Lu', texto: '92% do limite diário de mensagens ativas usado. Campanha reagendada para amanhã.' },
    { nivel: 'Atenção', cliente: 'Pet Shop Patinhas', texto: 'Cobrança da assinatura recusada. Nova tentativa automática amanhã às 9h.' },
    { nivel: 'Info', cliente: 'Barbearia Navalha', texto: 'Novo dispositivo entrou na conta (Campinas, SP) com verificação por código.' },
  ],
};

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
