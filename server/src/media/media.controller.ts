import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { Db } from '../db/db.service';

const ALLOWED = /^(image\/(jpeg|png|webp)|application\/pdf|video\/mp4|application\/(msword|vnd\.openxmlformats-officedocument\..+|vnd\.ms-excel))$/;
export const mediaDir = () => join(config.dataDir, 'media');

export interface MediaRow { id: number; filename: string; mimetype: string; size_bytes: number; path: string }

export function readMedia(m: MediaRow) {
  return { mimetype: m.mimetype, filename: m.filename, data: readFileSync(join(mediaDir(), m.path)).toString('base64') };
}

@Controller('media')
export class MediaController {
  constructor(private readonly db: Db) {}

  @Get()
  list() { return this.db.query('select id, filename, mimetype, size_bytes, created_at from media order by id desc limit 200'); }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED.test(file.mimetype)) throw new BadRequestException(`Unsupported file type: ${file.mimetype}. Use JPG/PNG/WEBP images, PDF, MP4 or Office documents.`);
    mkdirSync(mediaDir(), { recursive: true });
    const name = `${randomUUID()}${extname(file.originalname).toLowerCase().slice(0, 10)}`;
    writeFileSync(join(mediaDir(), name), file.buffer);
    const safeName = file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    return this.db.one('insert into media(filename, mimetype, size_bytes, path) values ($1,$2,$3,$4) returning id, filename, mimetype, size_bytes',
      [safeName, file.mimetype, file.size, name]);
  }

  @Get(':id')
  async file(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const m = await this.db.one<MediaRow>('select * from media where id=$1', [id]);
    if (!m) throw new NotFoundException();
    res.setHeader('Content-Type', m.mimetype);
    res.setHeader('Content-Disposition', `inline; filename="${m.filename}"`);
    res.sendFile(join(mediaDir(), m.path));
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const m = await this.db.one<MediaRow>('select * from media where id=$1', [id]);
    if (!m) return { ok: true };
    const used = await this.db.one(`select 1 from campaigns where media_id=$1 and status in ('running','paused') limit 1`, [id]);
    if (used) throw new BadRequestException('This file is used by an active campaign');
    await this.db.query('delete from media where id=$1', [id]);
    try { unlinkSync(join(mediaDir(), m.path)); } catch { /* already gone */ }
    return { ok: true };
  }
}
