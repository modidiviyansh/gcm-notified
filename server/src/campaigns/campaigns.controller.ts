import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CampaignsService } from './campaigns.service';
import { Db } from '../db/db.service';
import { checkTemplate } from './render';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get() list() { return this.campaigns.list(); }
  @Post() create(@Body() b: any) { return this.campaigns.create(b); }
  @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.campaigns.detail(id); }
  @Put(':id') update(@Param('id', ParseIntPipe) id: number, @Body() b: any) { return this.campaigns.update(id, b); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.campaigns.remove(id); }
  @Post(':id/duplicate') duplicate(@Param('id', ParseIntPipe) id: number) { return this.campaigns.duplicate(id); }

  @Post(':id/csv')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  csv(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Body('keyColumn') keyColumn?: string) {
    return this.campaigns.uploadCsv(id, file, keyColumn);
  }
  @Delete(':id/csv') removeCsv(@Param('id', ParseIntPipe) id: number) { return this.campaigns.removeCsv(id); }

  @Get(':id/preview') preview(@Param('id', ParseIntPipe) id: number) { return this.campaigns.preview(id); }
  @Post(':id/test') test(@Param('id', ParseIntPipe) id: number, @Body() b: { phone: string; numberId: number }) { return this.campaigns.testSend(id, b.phone, Number(b.numberId)); }
  @Post(':id/launch') launch(@Param('id', ParseIntPipe) id: number) { return this.campaigns.launch(id); }
  @Post(':id/pause') pause(@Param('id', ParseIntPipe) id: number) { return this.campaigns.setStatus(id, 'paused'); }
  @Post(':id/resume') resume(@Param('id', ParseIntPipe) id: number) { return this.campaigns.setStatus(id, 'running'); }
  @Post(':id/cancel') cancel(@Param('id', ParseIntPipe) id: number) { return this.campaigns.setStatus(id, 'cancelled'); }
  @Post(':id/retry-failed') retry(@Param('id', ParseIntPipe) id: number) { return this.campaigns.retryFailed(id); }

  @Get(':id/messages')
  messages(@Param('id', ParseIntPipe) id: number, @Query('status') status?: string, @Query('q') q?: string, @Query('offset') offset = '0') {
    return this.campaigns.messages(id, status, q, Number(offset) || 0);
  }
}

@Controller('templates')
export class TemplatesController {
  constructor(private readonly db: Db) {}
  @Get() list() { return this.db.query('select * from templates order by name'); }
  @Post() create(@Body() b: { name: string; body: string; media_id?: number | null }) {
    checkTemplate(b.body ?? '');
    return this.db.one('insert into templates(name, body, media_id) values ($1,$2,$3) returning *', [b.name?.trim() || 'Template', b.body ?? '', b.media_id ?? null]);
  }
  @Put(':id') update(@Param('id', ParseIntPipe) id: number, @Body() b: { name: string; body: string; media_id?: number | null }) {
    checkTemplate(b.body ?? '');
    return this.db.one('update templates set name=$2, body=$3, media_id=$4, updated_at=now() where id=$1 returning *', [id, b.name, b.body, b.media_id ?? null]);
  }
  @Delete(':id') async remove(@Param('id', ParseIntPipe) id: number) { await this.db.query('delete from templates where id=$1', [id]); return { ok: true }; }
}
