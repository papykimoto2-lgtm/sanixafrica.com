import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z, ZodType } from 'zod';

export class Valider<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException({
        message: 'Données invalides',
        erreurs: r.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

export const uuid = z.string().uuid();
export const motifObligatoire = z.string().trim().min(5, 'Un motif (≥ 5 caractères) est obligatoire pour toute modification');
export const dateIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ');
export const polygoneGeoJSON = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.any()).min(1),
});

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  taille: z.coerce.number().int().min(1).max(500).default(50),
});

export function offset(p: { page: number; taille: number }) {
  return (p.page - 1) * p.taille;
}

/** Construit une clause UPDATE à partir des seuls champs fournis (liste blanche). */
export function setClause(data: Record<string, unknown>, autorises: string[], depart = 1) {
  const champs = Object.keys(data).filter((k) => autorises.includes(k) && data[k] !== undefined);
  return {
    sql: champs.map((c, i) => `${c} = $${depart + i}`).join(', '),
    valeurs: champs.map((c) => data[c]),
    vide: champs.length === 0,
  };
}
