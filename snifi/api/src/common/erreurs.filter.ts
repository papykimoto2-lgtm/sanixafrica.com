import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/** Traduit les erreurs PostgreSQL et métier SNIFI en réponses HTTP explicites. */
@Catch()
export class ErreursFilter implements ExceptionFilter {
  private readonly logger = new Logger('SNIFI');

  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      return res.status(err.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    }
    const map: Record<string, [number, string]> = {
      SN001: [HttpStatus.BAD_REQUEST, 'Motif obligatoire pour toute modification ou suppression'],
      SN002: [HttpStatus.FORBIDDEN, "Le journal d'audit est immuable"],
      '23505': [HttpStatus.CONFLICT, 'Doublon : un enregistrement avec cet identifiant existe déjà'],
      '23503': [HttpStatus.BAD_REQUEST, 'Référence inexistante'],
      '23514': [HttpStatus.BAD_REQUEST, 'Valeur non conforme aux contraintes du référentiel'],
      '22P02': [HttpStatus.BAD_REQUEST, 'Format de donnée invalide'],
      XX000: [HttpStatus.BAD_REQUEST, 'Géométrie invalide'],
    };
    const known = err?.code && map[err.code];
    if (known) {
      return res.status(known[0]).json({ message: known[1], detail: err.detail ?? err.message, code: err.code });
    }
    this.logger.error(err?.message ?? err, err?.stack);
    return res.status(500).json({ message: 'Erreur interne' });
  }
}
